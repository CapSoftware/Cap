#![allow(unused_mut)]
#![allow(unused_imports)]

use anyhow::anyhow;
use futures::pin_mut;
use scap_targets::{Display, DisplayId};
use serde::Deserialize;
use specta::Type;
use std::{
    ops::Deref,
    path::PathBuf,
    str::FromStr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};
use tauri_specta::Event;
use tokio::sync::RwLock;
use tracing::{debug, error, info, instrument, warn};

#[cfg(target_os = "macos")]
use crate::panel_manager::{PanelManager, PanelState, PanelWindowType, is_window_handle_valid};

use crate::{
    App, ArcLock, CameraWindowCloseGate, CameraWindowPositionGuard, MainWindowReadyState,
    NewNotification, RequestSetTargetMode, camera_preview_error_message,
    editor_window::PendingEditorInstances,
    emit_camera_preview_clear, emit_camera_preview_error, fake_window,
    general_settings::{self, AppTheme, GeneralSettingsStore},
    permissions,
    recording::{RecordingEvent, RecordingInputKind},
    recording_settings::RecordingTargetMode,
    screenshot_editor::PendingScreenshotEditorInstances,
    target_select_overlay::WindowFocusManager,
    window_exclusion::WindowExclusion,
};
use cap_recording::{feeds, sources::screen_capture::ScreenCaptureTarget};

#[cfg(target_os = "macos")]
const DEFAULT_TRAFFIC_LIGHTS_INSET: LogicalPosition<f64> = LogicalPosition::new(12.0, 12.0);

#[cfg(target_os = "macos")]
const MAIN_PANEL_LEVEL: i32 = 100;

#[cfg(target_os = "macos")]
const TELEPROMPTER_PANEL_LEVEL: objc2_app_kit::NSWindowLevel = MAIN_PANEL_LEVEL as isize + 1;

const DEFAULT_FALLBACK_DISPLAY_WIDTH: f64 = 1920.0;
const DEFAULT_FALLBACK_DISPLAY_HEIGHT: f64 = 1080.0;

#[cfg(windows)]
const WINDOWS_WEBVIEW2_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --disable-vulkan --use-angle=d3d11";

#[cfg(windows)]
fn windows_webview2_browser_args() -> String {
    let mut args = WINDOWS_WEBVIEW2_BROWSER_ARGS.to_string();
    if cap_rendering::force_software_wgpu_adapter()
        || std::env::args_os().any(|arg| arg.to_str() == Some("--disable-gpu"))
    {
        args.push_str(" --disable-gpu");
    }
    args
}

#[cfg(target_os = "macos")]
fn is_system_dark_mode() -> bool {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let app: id = msg_send![class!(NSApplication), sharedApplication];
        let appearance: id = msg_send![app, effectiveAppearance];
        if appearance == nil {
            return false;
        }
        let name: id = msg_send![appearance, name];
        if name == nil {
            return false;
        }
        let dark_appearance = NSString::alloc(nil).init_str("NSAppearanceNameDarkAqua");
        let vibrant_dark = NSString::alloc(nil).init_str("NSAppearanceNameVibrantDark");
        let is_dark: bool = msg_send![name, isEqualToString: dark_appearance];
        let is_vibrant_dark: bool = msg_send![name, isEqualToString: vibrant_dark];
        is_dark || is_vibrant_dark
    }
}

#[cfg(target_os = "windows")]
fn is_system_dark_mode() -> bool {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) =
        hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
        && let Ok(value) = key.get_value::<u32, _>("AppsUseLightTheme")
    {
        return value == 0;
    }
    false
}

#[cfg(target_os = "linux")]
fn is_system_dark_mode() -> bool {
    let output = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "color-scheme"])
        .output();
    if let Ok(output) = output
        && output.status.success()
    {
        return String::from_utf8_lossy(&output.stdout).contains("dark");
    }
    false
}

pub fn hide_overlay(window: &WebviewWindow) {
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.hide();
}

pub fn show_overlay(window: &WebviewWindow) {
    let _ = window.set_ignore_cursor_events(false);
    let _ = window.show();
}

fn emit_app_event<E>(app: &AppHandle, event: E)
where
    E: Event + serde::Serialize + Clone,
{
    let event_name = std::any::type_name::<E>();
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| event.emit(app))) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => warn!(event = event_name, %error, "Failed to emit app event"),
        Err(panic) => {
            let message = crate::panic_payload_message(&panic);
            error!(event = event_name, panic = %message, "Suppressed panic while emitting app event");
        }
    }
}

fn hide_recording_windows(app: &AppHandle, restore_target_select_overlays: bool) {
    let focus_manager = app.try_state::<WindowFocusManager>();

    for (label, window) in app.webview_windows() {
        if let Ok(id) = CapWindowId::from_str(&label)
            && matches!(
                id,
                CapWindowId::TargetSelectOverlay { .. } | CapWindowId::Main | CapWindowId::Camera
            )
        {
            if matches!(id, CapWindowId::TargetSelectOverlay { .. }) {
                if restore_target_select_overlays
                    && window.is_visible().unwrap_or(false)
                    && let Some(focus_manager) = focus_manager.as_ref()
                {
                    focus_manager.remember_overlay_for_restore(label);
                }
                hide_overlay(&window);
            } else {
                let _ = window.hide();
            }
        }
    }
}

/// Release the live camera preview feed after `hide_recording_windows` when a
/// foreground window (Settings, an editor) takes over. Hiding the camera window
/// alone leaves the capture session running, so the OS camera-in-use indicator
/// stays lit while the user is in the editor. `restore_main_window_inputs`
/// re-attaches the feed when the main window comes back.
fn release_camera_preview_if_idle(app: &AppHandle) {
    let is_recording = app
        .try_state::<ArcLock<App>>()
        .and_then(|state| {
            state
                .try_read()
                .ok()
                .map(|state| state.is_recording_active_or_pending())
        })
        .unwrap_or(true);

    if is_recording {
        return;
    }

    let app = app.clone();
    tokio::spawn(async move {
        if let Some(state) = app.try_state::<ArcLock<App>>() {
            let app_state = &mut *state.write().await;
            app_state.camera_preview.pause();
            let _ = app_state.camera_feed.ask(feeds::camera::RemoveInput).await;
            app_state.camera_in_use = false;
        } else {
            warn!("App state unavailable while pausing camera preview");
        }
    });
}

fn bump_camera_window_session(app: &AppHandle) -> u64 {
    app.state::<Arc<AtomicU64>>().fetch_add(1, Ordering::AcqRel) + 1
}

fn camera_window_label_for_session(session_id: u64) -> String {
    format!("camera-{session_id}")
}

fn is_camera_window_label(label: &str) -> bool {
    label == "camera"
        || label
            .strip_prefix("camera-")
            .is_some_and(|suffix| suffix.parse::<u64>().is_ok())
}

fn camera_window_rank(label: &str) -> u64 {
    if label == "camera" {
        return 0;
    }

    label
        .strip_prefix("camera-")
        .and_then(|suffix| suffix.parse::<u64>().ok())
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn camera_window_labels(app: &AppHandle<Wry>) -> Vec<String> {
    app.webview_windows()
        .into_keys()
        .filter(|label| is_camera_window_label(label))
        .collect()
}

fn camera_webview_window_entries(app: &AppHandle<Wry>) -> Vec<(String, WebviewWindow)> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| is_camera_window_label(label))
        .collect()
}

fn camera_webview_windows(app: &AppHandle<Wry>) -> Vec<WebviewWindow> {
    camera_webview_window_entries(app)
        .into_iter()
        .map(|(_, window)| window)
        .collect()
}

fn current_camera_window(app: &AppHandle<Wry>) -> Option<WebviewWindow> {
    #[cfg(target_os = "macos")]
    {
        camera_webview_window_entries(app)
            .into_iter()
            .filter(|(_, window)| is_window_handle_valid(window))
            .max_by_key(|(label, _)| camera_window_rank(label))
            .map(|(_, window)| window)
    }

    #[cfg(not(target_os = "macos"))]
    {
        camera_webview_window_entries(app)
            .into_iter()
            .max_by_key(|(label, _)| camera_window_rank(label))
            .map(|(_, window)| window)
    }
}

fn destroy_camera_window_handle(
    app: &AppHandle<Wry>,
    window: WebviewWindow,
) -> tokio::sync::oneshot::Receiver<()> {
    let (destroy_tx, destroy_rx) = tokio::sync::oneshot::channel();
    let _ = window.as_ref().close();
    app.run_on_main_thread({
        let window = window.clone();
        move || {
            let _ = window.destroy();
            let _ = destroy_tx.send(());
        }
    })
    .ok();
    destroy_rx
}

async fn init_native_camera_preview(
    app_state: &mut App,
    window: WebviewWindow,
) -> Result<(), String> {
    let camera_feed = app_state.camera_feed.clone();
    let init_result = app_state
        .camera_preview
        .init_window(window, camera_feed.clone())
        .await;

    match init_result {
        Ok(()) => {
            #[allow(deprecated)]
            let camera_ws_sender = app_state.camera_ws_sender.clone();
            #[allow(deprecated)]
            if let Err(err) = camera_feed
                .ask(feeds::camera::RemoveSender(camera_ws_sender))
                .await
            {
                warn!(error = %err, "Failed to remove legacy camera preview sender");
            }
            Ok(())
        }
        Err(err) => {
            #[allow(deprecated)]
            let camera_ws_sender = app_state.camera_ws_sender.clone();
            #[allow(deprecated)]
            if let Err(add_err) = camera_feed
                .ask(feeds::camera::AddSender(camera_ws_sender))
                .await
            {
                warn!(error = %add_err, "Failed to restore legacy camera preview sender");
            }
            Err(err.to_string())
        }
    }
}

pub(crate) async fn ensure_camera_input_active(app_state: &mut App) {
    if let Some(id) = app_state.selected_camera_id.clone()
        && !app_state.camera_in_use
    {
        let settings = crate::recording_settings::RecordingSettingsStore::camera_settings_for(
            &app_state.handle,
            &id,
        );
        match app_state
            .camera_feed
            .ask(feeds::camera::SetInput { id, settings })
            .await
        {
            Ok(ready_future) => {
                if let Err(err) = ready_future.await {
                    error!("Camera failed to initialize: {err}");
                    return;
                }
            }
            Err(err) => {
                error!("Failed to send SetInput to camera feed: {err}");
                return;
            }
        }

        app_state.camera_in_use = true;
        app_state.camera_cleanup_done = false;
    }
}

pub(crate) async fn restore_main_window_inputs(app: &AppHandle) {
    let Some(state) = app.try_state::<ArcLock<App>>() else {
        warn!("App state unavailable while restoring main window inputs");
        return;
    };

    let should_restore = state
        .try_read()
        .map(|state| !state.is_recording_active_or_pending())
        .unwrap_or(false);

    if !should_restore {
        return;
    }

    let settings = crate::recording_settings::RecordingSettingsStore::get(app)
        .ok()
        .flatten()
        .unwrap_or_default();
    let stored_camera_id = settings.camera_id.clone();

    if let Err(err) = crate::set_mic_input(state.clone(), settings.mic_name).await {
        warn!("Failed to restore microphone input for main window: {err}");
    }

    let Some(operation_lock) = app.try_state::<crate::CameraWindowOperationLock>() else {
        warn!("CameraWindowOperationLock unavailable while restoring main window inputs");
        return;
    };
    let operation_guard = operation_lock.lock().await;

    let camera_to_restore = state
        .try_read()
        .map(|s| {
            if !s.camera_cleanup_done && !s.camera_in_use {
                s.selected_camera_id
                    .clone()
                    .or_else(|| stored_camera_id.clone())
            } else {
                None
            }
        })
        .unwrap_or(None);

    if let Some(camera_id) = camera_to_restore {
        emit_camera_preview_clear(app);
        let settings =
            crate::recording_settings::RecordingSettingsStore::camera_settings_for(app, &camera_id);

        let (camera_feed, camera_ws_sender, native_sender) = {
            let app_state = &mut *state.write().await;
            app_state.selected_camera_id = Some(camera_id.clone());
            app_state.camera_in_use = true;
            app_state.camera_cleanup_done = false;
            #[allow(deprecated)]
            (
                app_state.camera_feed.clone(),
                app_state.camera_ws_sender.clone(),
                app_state.camera_preview.sender(),
            )
        };

        if let Some(sender) = native_sender {
            #[allow(deprecated)]
            let _ = camera_feed
                .ask(feeds::camera::RemoveSender(camera_ws_sender))
                .await;
            if let Err(err) = sender.attach(&camera_feed).await {
                warn!(error = %err, "Failed to add native preview camera sender");
            }
        } else {
            #[allow(deprecated)]
            let _ = camera_feed
                .ask(feeds::camera::AddSender(camera_ws_sender))
                .await;
        }

        let mut showed_camera_window = false;
        let mut attempts = 0;
        let init_result: Result<(), String> = loop {
            attempts += 1;
            let request = camera_feed
                .ask(feeds::camera::SetInput {
                    id: camera_id.clone(),
                    settings,
                })
                .await
                .map_err(|e| e.to_string());

            if !showed_camera_window {
                showed_camera_window = true;
                crate::show_camera_window_unlocked(app);
            }

            match request {
                Ok(future) => match future.await {
                    Ok(_) => {
                        emit_camera_preview_clear(app);
                        break Ok(());
                    }
                    Err(e) => {
                        if attempts == 1 {
                            emit_camera_preview_error(
                                app,
                                camera_preview_error_message(&e.to_string()),
                            );
                        }
                        if attempts >= 3 {
                            break Err(format!(
                                "Failed to restore camera after {attempts} attempts: {e}"
                            ));
                        }
                        warn!("Camera restore attempt {attempts} failed: {e}. Retrying...");
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                },
                Err(e) => {
                    if attempts >= 3 {
                        break Err(e);
                    }
                    warn!("Camera restore attempt {attempts} failed: {e}. Retrying...");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        };

        drop(operation_guard);

        match init_result {
            Ok(()) => crate::restore_camera_window(app),
            Err(error) => {
                let message = camera_preview_error_message(&error);
                warn!("Failed to restore camera input for main window: {error}");
                let _ = camera_feed.ask(feeds::camera::RemoveInput).await;
                let emit_input_lost = {
                    let app_state = &mut *state.write().await;
                    app_state.selected_camera_id = None;
                    app_state.camera_in_use = false;
                    app_state
                        .disconnected_inputs
                        .insert(RecordingInputKind::Camera)
                };
                crate::show_camera_window_unlocked(app);
                if emit_input_lost {
                    let _ = RecordingEvent::InputLost {
                        input: RecordingInputKind::Camera,
                    }
                    .emit(app);
                }
                emit_camera_preview_error(app, message.clone());
                let _ = NewNotification {
                    title: "Camera unavailable".to_string(),
                    body: message,
                    is_error: true,
                }
                .emit(app);
            }
        }
    }
}

pub(crate) async fn cleanup_camera_window(
    app: &AppHandle,
    window: Option<&WebviewWindow>,
    #[allow(unused_variables)] reset_panel: bool,
    wait_for_removal: bool,
) -> bool {
    use crate::CameraWindowCloseGate;

    #[cfg(target_os = "macos")]
    if reset_panel {
        let panel_manager = app.state::<PanelManager>();
        panel_manager.force_reset(PanelWindowType::Camera).await;
    }

    app.state::<CameraWindowCloseGate>().set_allow_close(true);

    #[cfg(target_os = "macos")]
    {
        let panel_labels = window
            .map(|window| vec![window.label().to_string()])
            .unwrap_or_else(|| camera_window_labels(app));
        let (panel_close_tx, panel_close_rx) = tokio::sync::oneshot::channel();
        let app_for_close = app.clone();
        app.run_on_main_thread(move || {
            use tauri_nspanel::ManagerExt;
            for label in panel_labels {
                if let Ok(panel) = app_for_close.get_webview_panel(&label) {
                    panel.released_when_closed(false);
                    panel.close();
                }
            }
            let _ = panel_close_tx.send(());
        })
        .ok();
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), panel_close_rx).await;
    }

    let windows = window
        .cloned()
        .map(|window| vec![window])
        .unwrap_or_else(|| camera_webview_windows(app));
    for window in windows {
        let destroy_rx = destroy_camera_window_handle(app, window);
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), destroy_rx).await;
    }

    if wait_for_removal {
        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_millis(2000);
        while start.elapsed() < timeout && !camera_webview_windows(app).is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    let still_exists = !camera_webview_windows(app).is_empty();
    app.state::<CameraWindowCloseGate>().set_allow_close(false);

    !still_exists
}

struct CursorMonitorInfo {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    // On Windows each monitor's "logical" rect is its physical rect divided by
    // its own scale, so logical rects of mixed-DPI monitors overlap and tao's
    // LogicalPosition conversion (which uses whatever monitor the window
    // currently occupies) can land a window on the wrong monitor. Positioning
    // must go through this monitor's own scale, as a physical position.
    #[cfg(windows)]
    scale: f64,
}

impl CursorMonitorInfo {
    fn get() -> Self {
        Self::from_display(&Display::get_containing_cursor().unwrap_or_else(Display::primary))
    }

    fn from_display(display: &Display) -> Self {
        let bounds = display.raw_handle().logical_bounds();

        #[cfg(windows)]
        let scale = bounds
            .as_ref()
            .map(|b| b.size().width())
            .filter(|width| *width > 0.0)
            .and_then(|logical_width| {
                display
                    .physical_size()
                    .map(|physical| physical.width() / logical_width)
            })
            .filter(|scale| scale.is_finite() && *scale > 0.0)
            .unwrap_or(1.0);

        let (x, y, width, height) = bounds
            .map(|b| {
                (
                    b.position().x(),
                    b.position().y(),
                    b.size().width(),
                    b.size().height(),
                )
            })
            .unwrap_or((
                0.0,
                0.0,
                DEFAULT_FALLBACK_DISPLAY_WIDTH,
                DEFAULT_FALLBACK_DISPLAY_HEIGHT,
            ));

        Self {
            x,
            y,
            width,
            height,
            #[cfg(windows)]
            scale,
        }
    }

    /// Converts a global-logical point on this monitor into a `Position` that
    /// lands exactly there regardless of which monitor the window currently
    /// occupies. Logical on macOS/Linux (a true global space there), physical
    /// on Windows.
    fn position(&self, x: f64, y: f64) -> tauri::Position {
        #[cfg(windows)]
        return tauri::Position::Physical(tauri::PhysicalPosition::new(
            (x * self.scale).round() as i32,
            (y * self.scale).round() as i32,
        ));

        #[cfg(not(windows))]
        tauri::Position::Logical(tauri::LogicalPosition::new(x, y))
    }

    fn center_position(&self, window_width: f64, window_height: f64) -> (f64, f64) {
        let pos_x = self.x + (self.width - window_width) / 2.0;
        let pos_y = self.y + (self.height - window_height) / 2.0;
        (pos_x, pos_y)
    }

    fn bottom_center_position(
        &self,
        window_width: f64,
        window_height: f64,
        offset_y: f64,
    ) -> (f64, f64) {
        let pos_x = self.x + (self.width - window_width) / 2.0;
        let pos_y = self.y + self.height - window_height - offset_y;
        (pos_x, pos_y)
    }

    fn from_window(window: &tauri::WebviewWindow) -> Self {
        let Ok(window_pos) = window.outer_position() else {
            return Self::get();
        };

        // outer_position is physical. On Windows, resolve the display in
        // physical space (per-monitor logical rects overlap in mixed-DPI
        // layouts). On macOS, convert to logical points, a true global space.
        // On Linux scap reports logical bounds in unscaled physical units, so
        // the raw position compares directly.
        #[cfg(windows)]
        {
            let (pos_x, pos_y) = (window_pos.x as f64, window_pos.y as f64);
            for display in Display::list() {
                if let Some(bounds) = display.raw_handle().physical_bounds() {
                    let (x, y, width, height) = (
                        bounds.position().x(),
                        bounds.position().y(),
                        bounds.size().width(),
                        bounds.size().height(),
                    );

                    if pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height {
                        return Self::from_display(&display);
                    }
                }
            }

            Self::get()
        }

        #[cfg(target_os = "macos")]
        {
            let scale = window.scale_factor().unwrap_or(1.0);
            let pos = window_pos.to_logical::<f64>(scale);

            for display in Display::list() {
                if display_contains_logical(&display, pos.x, pos.y) {
                    return Self::from_display(&display);
                }
            }

            Self::get()
        }

        #[cfg(target_os = "linux")]
        {
            let (pos_x, pos_y) = (window_pos.x as f64, window_pos.y as f64);

            for display in Display::list() {
                if display_contains_logical(&display, pos_x, pos_y) {
                    return Self::from_display(&display);
                }
            }

            Self::get()
        }
    }
}

fn display_contains_logical(display: &Display, pos_x: f64, pos_y: f64) -> bool {
    display
        .raw_handle()
        .logical_bounds()
        .map(|bounds| {
            let (x, y, width, height) = (
                bounds.position().x(),
                bounds.position().y(),
                bounds.size().width(),
                bounds.size().height(),
            );

            pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height
        })
        .unwrap_or(false)
}

fn display_containing_logical(pos_x: f64, pos_y: f64) -> Option<Display> {
    Display::list()
        .into_iter()
        .find(|display| display_contains_logical(display, pos_x, pos_y))
}

/// Resolves the display a persisted window position belongs to, preferring the
/// display it was saved on. On Windows the saved logical coordinates are only
/// meaningful relative to that display (mixed-DPI logical rects overlap), so
/// restores must convert through its scale rather than the window's current one.
fn display_for_saved_position(
    pos_x: f64,
    pos_y: f64,
    display_id: Option<&DisplayId>,
) -> Option<Display> {
    display_id
        .and_then(Display::from_id)
        .filter(|display| display_contains_logical(display, pos_x, pos_y))
        .or_else(|| display_containing_logical(pos_x, pos_y))
}

/// Converts a global-logical point into a `Position` that lands exactly there,
/// resolving the owning display by containment when the caller doesn't know it.
/// Falls back to a plain logical position when no display contains the point.
pub fn logical_point_position(pos_x: f64, pos_y: f64) -> tauri::Position {
    #[cfg(windows)]
    if let Some(display) = display_containing_logical(pos_x, pos_y) {
        return CursorMonitorInfo::from_display(&display).position(pos_x, pos_y);
    }

    tauri::Position::Logical(tauri::LogicalPosition::new(pos_x, pos_y))
}

fn center_camera_window(app: &AppHandle, window: &WebviewWindow) {
    let camera_state = match app.try_state::<ArcLock<crate::App>>() {
        Some(state) => state
            .try_read()
            .ok()
            .and_then(|guard| guard.camera_preview.get_state().ok())
            .unwrap_or_default(),
        None => crate::camera::CameraPreviewState::default(),
    };

    let toolbar_height = 56.0;
    let size = camera_state.size as f64;
    let is_full = camera_state.shape == crate::camera::CameraPreviewShape::Full;
    let aspect_ratio = crate::camera::WIDE_CAMERA_ASPECT_RATIO as f64;

    let window_width = if is_full { size * aspect_ratio } else { size };
    let window_height = size + toolbar_height;

    let monitor_info = CursorMonitorInfo::get();
    let (pos_x, pos_y) = monitor_info.center_position(window_width, window_height);

    let _ = window.set_size(tauri::LogicalSize::new(window_width, window_height));
    if let Some(guard) = app.try_state::<CameraWindowPositionGuard>() {
        guard.ignore_for(1000);
    }
    let _ = window.set_position(monitor_info.position(pos_x, pos_y));

    if let Some(state) = app.try_state::<ArcLock<crate::App>>()
        && let Ok(guard) = state.try_read()
    {
        guard
            .camera_preview
            .notify_window_resized(window_width as u32, window_height as u32);
    }
}

fn is_position_on_display(display_id: &DisplayId, pos_x: f64, pos_y: f64) -> bool {
    Display::from_id(display_id)
        .and_then(|display| display.raw_handle().logical_bounds())
        .map(|bounds| {
            let (x, y, width, height) = (
                bounds.position().x(),
                bounds.position().y(),
                bounds.size().width(),
                bounds.size().height(),
            );

            pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height
        })
        .unwrap_or(false)
}

fn display_name_for_position(pos_x: f64, pos_y: f64) -> Option<String> {
    Display::list().into_iter().find_map(|display| {
        let bounds = display.raw_handle().logical_bounds()?;
        let (x, y, width, height) = (
            bounds.position().x(),
            bounds.position().y(),
            bounds.size().width(),
            bounds.size().height(),
        );

        if pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height {
            display.name().filter(|name| !name.trim().is_empty())
        } else {
            None
        }
    })
}

fn is_position_on_monitor_name(monitor_name: &str, pos_x: f64, pos_y: f64) -> bool {
    Display::list().into_iter().any(|display| {
        if display.name().as_deref() != Some(monitor_name) {
            return false;
        }

        display
            .raw_handle()
            .logical_bounds()
            .map(|bounds| {
                let (x, y, width, height) = (
                    bounds.position().x(),
                    bounds.position().y(),
                    bounds.size().width(),
                    bounds.size().height(),
                );

                pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height
            })
            .unwrap_or(false)
    })
}

fn is_position_on_any_screen(pos_x: f64, pos_y: f64) -> bool {
    for display in Display::list() {
        if let Some(bounds) = display.raw_handle().logical_bounds() {
            let (x, y, width, height) = (
                bounds.position().x(),
                bounds.position().y(),
                bounds.size().width(),
                bounds.size().height(),
            );

            if pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height {
                return true;
            }
        }
    }
    false
}

// Recovers a window that ended up entirely off every connected display (e.g. the
// monitor it was on got disconnected), which otherwise leaves it open but unreachable.
fn recenter_window_if_offscreen(window: &WebviewWindow) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);

    let on_screen = Display::list()
        .iter()
        .any(|display| display.intersects(position, size, scale));
    if on_screen {
        return;
    }

    let monitor = CursorMonitorInfo::get();
    let (pos_x, pos_y) =
        monitor.center_position(size.width as f64 / scale, size.height as f64 / scale);
    let _ = window.set_position(monitor.position(pos_x, pos_y));
}

fn ensure_settings_window_bounds(window: &WebviewWindow) {
    const MIN_W: f64 = 780.0;
    const MIN_H: f64 = 560.0;
    let _ = window.set_min_size(Some(LogicalSize::new(MIN_W, MIN_H)));
    if let (Ok(physical), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
        let width = physical.width as f64 / scale;
        let height = physical.height as f64 / scale;
        if width < MIN_W || height < MIN_H {
            let _ = window.set_size(LogicalSize::new(width.max(MIN_W), height.max(MIN_H)));
        }
    }
}

#[derive(Clone, Deserialize, Type)]
pub enum CapWindowId {
    Main,
    Settings,
    Editor { id: u32 },
    RecordingsOverlay,
    WindowCaptureOccluder { screen_id: DisplayId },
    TargetSelectOverlay { display_id: DisplayId },
    CaptureArea,
    Camera,
    RecordingControls,
    Upgrade,
    ModeSelect,
    Debug,
    ScreenshotEditor { id: u32 },
    Onboarding,
    Teleprompter,
}

impl FromStr for CapWindowId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s {
            "main" => Self::Main,
            "settings" => Self::Settings,
            s if is_camera_window_label(s) => Self::Camera,
            "capture-area" => Self::CaptureArea,
            // legacy identifier
            "in-progress-recording" => Self::RecordingControls,
            "recordings-overlay" => Self::RecordingsOverlay,
            "upgrade" => Self::Upgrade,
            "mode-select" => Self::ModeSelect,
            "debug" => Self::Debug,
            "onboarding" => Self::Onboarding,
            "teleprompter" => Self::Teleprompter,
            s if s.starts_with("editor-") => Self::Editor {
                id: s
                    .replace("editor-", "")
                    .parse::<u32>()
                    .map_err(|e| e.to_string())?,
            },
            s if s.starts_with("screenshot-editor-") => Self::ScreenshotEditor {
                id: s
                    .replace("screenshot-editor-", "")
                    .parse::<u32>()
                    .map_err(|e| e.to_string())?,
            },
            s if s.starts_with("window-capture-occluder-") => Self::WindowCaptureOccluder {
                screen_id: s
                    .replace("window-capture-occluder-", "")
                    .parse::<DisplayId>()
                    .map_err(|e| e.to_string())?,
            },
            s if s.starts_with("target-select-overlay-") => Self::TargetSelectOverlay {
                display_id: s
                    .replace("target-select-overlay-", "")
                    .parse::<DisplayId>()
                    .map_err(|e| e.to_string())?,
            },
            _ => return Err(format!("unknown window label: {s}")),
        })
    }
}

impl std::fmt::Display for CapWindowId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Main => write!(f, "main"),
            Self::Settings => write!(f, "settings"),
            Self::Camera => write!(f, "camera"),
            Self::WindowCaptureOccluder { screen_id } => {
                write!(f, "window-capture-occluder-{screen_id}")
            }
            Self::CaptureArea => write!(f, "capture-area"),
            Self::TargetSelectOverlay { display_id } => {
                write!(f, "target-select-overlay-{display_id}")
            }
            Self::RecordingControls => write!(f, "in-progress-recording"), // legacy identifier
            Self::RecordingsOverlay => write!(f, "recordings-overlay"),
            Self::Upgrade => write!(f, "upgrade"),
            Self::ModeSelect => write!(f, "mode-select"),
            Self::Editor { id } => write!(f, "editor-{id}"),
            Self::Debug => write!(f, "debug"),
            Self::ScreenshotEditor { id } => write!(f, "screenshot-editor-{id}"),
            Self::Onboarding => write!(f, "onboarding"),
            Self::Teleprompter => write!(f, "teleprompter"),
        }
    }
}

impl CapWindowId {
    pub fn label(&self) -> String {
        self.to_string()
    }

    pub fn title(&self) -> String {
        match self {
            Self::Settings => "Cap Settings".to_string(),
            Self::WindowCaptureOccluder { .. } => "Cap Window Capture Occluder".to_string(),
            Self::CaptureArea => "Cap Capture Area".to_string(),
            Self::RecordingControls => "Cap Recording Controls".to_string(),
            Self::Editor { .. } => "Cap Editor".to_string(),
            Self::ScreenshotEditor { .. } => "Cap Screenshot Editor".to_string(),
            Self::ModeSelect => "Cap Mode Selection".to_string(),
            Self::Onboarding => "Welcome to Cap".to_string(),
            Self::Camera => "Cap Camera".to_string(),
            Self::RecordingsOverlay => "Cap Recordings Overlay".to_string(),
            Self::TargetSelectOverlay { .. } => "Cap Target Select".to_string(),
            Self::Teleprompter => "Cap Teleprompter".to_string(),
            _ => "Cap".to_string(),
        }
    }

    #[cfg(target_os = "macos")]
    pub fn activates_dock(&self) -> bool {
        matches!(
            self,
            Self::Main
                | Self::Editor { .. }
                | Self::ScreenshotEditor { .. }
                | Self::Settings
                | Self::Upgrade
                | Self::ModeSelect
                | Self::Onboarding
        )
    }

    pub fn is_transparent(&self) -> bool {
        if matches!(self, Self::Settings) {
            return cfg!(target_os = "macos");
        }

        matches!(
            self,
            Self::Main
                | Self::Onboarding
                | Self::Camera
                | Self::WindowCaptureOccluder { .. }
                | Self::CaptureArea
                | Self::RecordingControls
                | Self::RecordingsOverlay
                | Self::TargetSelectOverlay { .. }
        )
    }

    pub fn get(&self, app: &AppHandle<Wry>) -> Option<WebviewWindow> {
        if matches!(self, Self::Camera) {
            return current_camera_window(app);
        }

        let label = self.label();
        app.get_webview_window(&label)
    }

    #[cfg(target_os = "macos")]
    pub fn traffic_lights_position(&self) -> Option<Option<LogicalPosition<f64>>> {
        match self {
            Self::Editor { .. } | Self::ScreenshotEditor { .. } => {
                Some(Some(LogicalPosition::new(20.0, 32.0)))
            }
            Self::Camera
            | Self::Main
            | Self::Onboarding
            | Self::WindowCaptureOccluder { .. }
            | Self::CaptureArea
            | Self::RecordingsOverlay
            | Self::RecordingControls
            | Self::TargetSelectOverlay { .. } => None,
            Self::Settings => Some(Some(LogicalPosition::new(22.0, 22.0))),
            Self::Teleprompter => Some(Some(LogicalPosition::new(14.0, 14.0))),
            _ => Some(None),
        }
    }

    pub fn min_size(&self) -> Option<(f64, f64)> {
        Some(match self {
            Self::Main => (330.0, 395.0),
            Self::Editor { .. } => (1275.0, 800.0),
            Self::ScreenshotEditor { .. } => (800.0, 600.0),
            Self::Settings => (780.0, 560.0),
            Self::Camera => (200.0, 200.0),
            Self::Upgrade => (950.0, 850.0),
            Self::ModeSelect => (580.0, 340.0),
            Self::Onboarding => (860.0, 690.0),
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Type, Deserialize)]
pub enum ShowCapWindow {
    Main {
        init_target_mode: Option<RecordingTargetMode>,
    },
    Settings {
        page: Option<String>,
    },
    Editor {
        project_path: PathBuf,
    },
    RecordingsOverlay,
    WindowCaptureOccluder {
        screen_id: DisplayId,
    },
    TargetSelectOverlay {
        display_id: DisplayId,
        target_mode: Option<RecordingTargetMode>,
    },
    CaptureArea {
        screen_id: DisplayId,
    },
    Camera {
        centered: bool,
    },
    InProgressRecording {
        countdown: Option<u32>,
        #[serde(default)]
        capture_target: Option<ScreenCaptureTarget>,
    },
    Upgrade,
    ModeSelect,
    ScreenshotEditor {
        path: PathBuf,
    },
    Onboarding,
}

impl ShowCapWindow {
    pub async fn show(&self, app: &AppHandle<Wry>) -> tauri::Result<WebviewWindow> {
        if let Self::Editor { project_path } = &self {
            let state = app.state::<EditorWindowIds>();
            let window_id = {
                let mut s = state.ids.lock().unwrap();
                if !s.iter().any(|(path, _)| path == project_path) {
                    let id = state
                        .counter
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    s.push((project_path.clone(), id));
                    id
                } else {
                    s.iter().find(|(path, _)| path == project_path).unwrap().1
                }
            };

            let window_label = CapWindowId::Editor { id: window_id }.label();
            PendingEditorInstances::start_prewarm(app, window_label, project_path.clone()).await;
        }

        if let Self::ScreenshotEditor { path } = &self {
            let state = app.state::<ScreenshotEditorWindowIds>();
            {
                let mut s = state.ids.lock().unwrap();
                if !s.iter().any(|(p, _)| p == path) {
                    let id = state
                        .counter
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    s.push((path.clone(), id));
                }
            }
        }

        let camera_window_label = if matches!(self, Self::Camera { .. }) {
            Some(camera_window_label_for_session(bump_camera_window_session(
                app,
            )))
        } else {
            None
        };

        if let Self::Camera { centered } = self {
            #[cfg(target_os = "macos")]
            {
                let panel_manager = app.state::<PanelManager>();
                let mut panel_state = panel_manager.get_state(PanelWindowType::Camera).await;

                if panel_state == PanelState::Destroying {
                    debug!("Camera window is being destroyed, waiting...");
                    let wait_result = panel_manager
                        .wait_for_state(
                            PanelWindowType::Camera,
                            &[PanelState::None],
                            std::time::Duration::from_millis(500),
                        )
                        .await;

                    if !wait_result {
                        warn!("Camera destroy wait timed out, force resetting state");
                        panel_manager.force_reset(PanelWindowType::Camera).await;
                    }
                    panel_state = panel_manager.get_state(PanelWindowType::Camera).await;
                }

                if panel_state == PanelState::Creating {
                    debug!("Camera window is being created, waiting...");
                    panel_manager
                        .wait_for_state(
                            PanelWindowType::Camera,
                            &[PanelState::Ready],
                            std::time::Duration::from_millis(500),
                        )
                        .await;
                }
            }

            if let Some(window) = self.id(app).get(app) {
                #[cfg(target_os = "macos")]
                {
                    use crate::panel_manager::is_window_handle_valid;

                    let handle_valid = is_window_handle_valid(&window);

                    if !handle_valid {
                        warn!(
                            "Camera window exists but handle is invalid, destroying and recreating..."
                        );
                        let cleanup_success =
                            cleanup_camera_window(app, Some(&window), true, true).await;
                        if !cleanup_success {
                            warn!(
                                "Camera window still in registry after cleanup attempts, will retry later"
                            );
                            return Err(tauri::Error::WindowNotFound);
                        }
                        debug!("Camera window successfully removed from registry");
                    } else {
                        let panel_manager = app.state::<PanelManager>();
                        let mut panel_state =
                            panel_manager.get_state(PanelWindowType::Camera).await;

                        if panel_state == PanelState::Creating {
                            debug!(
                                "Camera window valid but state is Creating, waiting for completion"
                            );
                            panel_manager
                                .wait_for_state(
                                    PanelWindowType::Camera,
                                    &[PanelState::Ready, PanelState::None],
                                    std::time::Duration::from_millis(1000),
                                )
                                .await;
                            panel_state = panel_manager.get_state(PanelWindowType::Camera).await;
                        }

                        if panel_state != PanelState::Ready {
                            debug!(
                                "Camera window exists but panel state is {:?}, updating to Ready",
                                panel_state
                            );
                            panel_manager.force_reset(PanelWindowType::Camera).await;
                            panel_manager.mark_ready(PanelWindowType::Camera, 0).await;
                        }

                        let Some(state) = app.try_state::<ArcLock<App>>() else {
                            warn!("App state unavailable while showing camera window");
                            return Err(tauri::Error::WindowNotFound);
                        };
                        let mut app_state = state.write().await;

                        let enable_native_camera_preview =
                            GeneralSettingsStore::native_camera_preview_enabled(app);

                        let shutdown_preview = if !enable_native_camera_preview {
                            app_state.camera_preview.begin_shutdown()
                        } else {
                            None
                        };

                        ensure_camera_input_active(&mut app_state).await;

                        if enable_native_camera_preview
                            && let Err(err) =
                                init_native_camera_preview(&mut app_state, window.clone()).await
                        {
                            error!(
                                "Error reinitializing camera preview for existing window: {err}"
                            );
                        }

                        drop(app_state);

                        if let Some(rx) = shutdown_preview {
                            let _ = tokio::time::timeout(Duration::from_millis(500), rx).await;
                        }

                        let (show_tx, show_rx) = tokio::sync::oneshot::channel();
                        app.run_on_main_thread({
                            let window = window.clone();
                            move || {
                                use crate::panel_manager::try_to_panel;

                                // IMPORTANT: We intentionally use window.show() + set_focus() here
                                // instead of panel.order_front_regardless().
                                //
                                // order_front_regardless() was found to cause a crash after ~4-5
                                // camera toggle cycles due to macOS internal state accumulation.
                                // The crash manifested as a hard crash in the Metal/CAMetalLayer
                                // subsystem, not in our Rust code.
                                //
                                // Using standard Tauri window APIs avoids this macOS-specific issue
                                // while still properly showing and focusing the camera preview window.
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = show_tx.send(true);
                            }
                        })
                        .ok();

                        let show_result = show_rx.await.unwrap_or(false);

                        if show_result {
                            if *centered {
                                center_camera_window(app, &window);
                            }
                            return Ok(window);
                        } else {
                            warn!("Camera panel show failed, will recreate window");
                            let cleanup_success =
                                cleanup_camera_window(app, Some(&window), true, true).await;
                            if !cleanup_success {
                                warn!(
                                    "Camera window still in registry after show failure, will retry later"
                                );
                                return Err(tauri::Error::WindowNotFound);
                            }
                            debug!("Camera window successfully removed after show failure");
                        }
                    }
                }

                #[cfg(not(target_os = "macos"))]
                {
                    let Some(state) = app.try_state::<ArcLock<App>>() else {
                        warn!("App state unavailable while showing camera window");
                        return Err(tauri::Error::WindowNotFound);
                    };
                    let mut app_state = state.write().await;

                    let enable_native_camera_preview =
                        GeneralSettingsStore::native_camera_preview_enabled(app);

                    let shutdown_preview = if !enable_native_camera_preview {
                        app_state.camera_preview.begin_shutdown()
                    } else {
                        None
                    };

                    ensure_camera_input_active(&mut app_state).await;

                    if enable_native_camera_preview
                        && let Err(err) =
                            init_native_camera_preview(&mut app_state, window.clone()).await
                    {
                        error!("Error reinitializing camera preview for existing window: {err}");
                    }

                    drop(app_state);

                    if let Some(rx) = shutdown_preview {
                        let _ = tokio::time::timeout(Duration::from_millis(500), rx).await;
                    }

                    if *centered {
                        center_camera_window(app, &window);
                    }
                    window.show().ok();
                    window.set_focus().ok();
                    return Ok(window);
                }
            }
        }

        if matches!(self, Self::Settings { .. }) {
            hide_recording_windows(app, true);
            release_camera_preview_if_idle(app);
        }

        #[cfg(target_os = "macos")]
        if let Self::InProgressRecording { capture_target, .. } = self
            && let Some(window) = self.id(app).get(app)
        {
            use crate::panel_manager::is_window_handle_valid;

            if is_window_handle_valid(&window) {
                debug!("InProgressRecording: reusing existing window");
                let width = 320.0;
                let height = 150.0;
                let (pos_x, pos_y) = capture_target
                    .as_ref()
                    .and_then(fake_window::calculate_recording_controls_position_for_target)
                    .unwrap_or_else(|| {
                        CursorMonitorInfo::get().bottom_center_position(width, height, 120.0)
                    });
                let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));

                let label = window.label().to_string();
                app.run_on_main_thread({
                    let app = app.clone();
                    move || {
                        use tauri_nspanel::ManagerExt;
                        if let Ok(panel) = app.get_webview_panel(&label) {
                            panel.order_front_regardless();
                            panel.show();
                        }
                    }
                })
                .ok();
                fake_window::spawn_fake_window_listener(app.clone(), window.clone());
                return Ok(window);
            } else {
                warn!("InProgressRecording window handle invalid, destroying and recreating...");
                let _ = window.destroy();

                let window_id = self.id(app);
                let max_wait = std::time::Duration::from_millis(500);
                let poll_interval = std::time::Duration::from_millis(25);
                let start = std::time::Instant::now();
                while start.elapsed() < max_wait {
                    if window_id.get(app).is_none() {
                        debug!(
                            "InProgressRecording window removed from registry after {:?}",
                            start.elapsed()
                        );
                        break;
                    }
                    tokio::time::sleep(poll_interval).await;
                }

                if window_id.get(app).is_some() {
                    error!("InProgressRecording window STILL in registry, cannot recreate");
                    return Err(tauri::Error::WindowNotFound);
                }
                debug!("InProgressRecording window cleaned up, will recreate");
            }
        }

        #[cfg(not(target_os = "macos"))]
        if let Self::InProgressRecording { capture_target, .. } = self
            && let Some(window) = self.id(app).get(app)
        {
            let width = 320.0;
            let height = 150.0;
            let (pos_x, pos_y) = capture_target
                .as_ref()
                .and_then(fake_window::calculate_recording_controls_position_for_target)
                .unwrap_or_else(|| {
                    CursorMonitorInfo::get().bottom_center_position(width, height, 120.0)
                });
            let _ = window.set_position(logical_point_position(pos_x, pos_y));
            window.show().ok();
            window.set_focus().ok();
            fake_window::spawn_fake_window_listener(app.clone(), window.clone());
            return Ok(window);
        }

        if !matches!(self, Self::Camera { .. } | Self::InProgressRecording { .. })
            && let Some(window) = self.id(app).get(app)
        {
            if matches!(self, Self::Main { .. }) && crate::should_show_onboarding(app) {
                return Box::pin(Self::Onboarding.show(app)).await;
            }

            #[cfg(target_os = "macos")]
            if matches!(self, Self::Main { .. }) && !app.state::<MainWindowReadyState>().is_ready()
            {
                return Ok(window);
            }

            let cursor_display_id = if let Self::Main { init_target_mode } = self {
                if init_target_mode.is_some() {
                    Display::get_containing_cursor()
                        .map(|d| d.id().to_string())
                        .or_else(|| Some(Display::primary().id().to_string()))
                } else {
                    None
                }
            } else {
                None
            };

            if let Self::Main {
                init_target_mode: Some(target_mode),
            } = self
            {
                window.hide().ok();
                emit_app_event(
                    app,
                    RequestSetTargetMode {
                        target_mode: Some(*target_mode),
                        display_id: cursor_display_id,
                    },
                );
            } else {
                let should_restore_main_window_inputs = matches!(self, Self::Main { .. });

                if let Self::Onboarding = self {
                    let _ = window.set_ignore_cursor_events(false);
                }

                if matches!(self, Self::Main { .. } | Self::Settings { .. }) {
                    recenter_window_if_offscreen(&window);
                }

                window.show().ok();
                window.unminimize().ok();
                window.set_focus().ok();

                if let Self::Settings { .. } = self {
                    ensure_settings_window_bounds(&window);
                }

                if let Self::Main { init_target_mode } = self {
                    emit_app_event(
                        app,
                        RequestSetTargetMode {
                            target_mode: *init_target_mode,
                            display_id: cursor_display_id,
                        },
                    );
                }

                if should_restore_main_window_inputs {
                    let app = app.clone();
                    tokio::spawn(async move {
                        restore_main_window_inputs(&app).await;
                    });
                }
            }

            #[cfg(target_os = "macos")]
            if self.id(app).activates_dock() {
                crate::permissions::sync_macos_dock_visibility(app);
            }

            return Ok(window);
        }

        let _id = self.id(app);
        let cursor_monitor = CursorMonitorInfo::get();

        let window = match self {
            Self::Main { init_target_mode } => {
                if !permissions::do_permissions_check(false).necessary_granted() {
                    return Box::pin(Self::Onboarding.show(app)).await;
                }

                let title = CapWindowId::Main.title();
                let should_protect = should_protect_window(app, &title);

                #[cfg(target_os = "macos")]
                let panel_activation_guard = permissions::prepare_macos_panel_window(app);

                let window = self
                    .window_builder(app, "/")
                    .resizable(false)
                    .maximized(false)
                    .maximizable(false)
                    .minimizable(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .content_protected(should_protect)
                    .transparent(true)
                    .visible(false)
                    .initialization_script(format!(
                        "
                        window.__CAP__ = window.__CAP__ ?? {{}};
                        window.__CAP__.initialTargetMode = {}
                    ",
                        serde_json::to_string(init_target_mode)
                            .expect("Failed to serialize initial target mode")
                    ))
                    .build()?;
                lock_window_text_scale(&window);

                let saved_position = GeneralSettingsStore::get(app)
                    .ok()
                    .flatten()
                    .and_then(|s| s.main_window_position)
                    .filter(|pos| is_position_on_any_screen(pos.x, pos.y));

                let main_position = if let Some(pos) = saved_position {
                    match display_for_saved_position(pos.x, pos.y, pos.display_id.as_ref()) {
                        Some(display) => {
                            CursorMonitorInfo::from_display(&display).position(pos.x, pos.y)
                        }
                        None => tauri::Position::Logical(tauri::LogicalPosition::new(pos.x, pos.y)),
                    }
                } else {
                    let (pos_x, pos_y) = cursor_monitor.center_position(330.0, 395.0);
                    cursor_monitor.position(pos_x, pos_y)
                };

                #[cfg(target_os = "macos")]
                {
                    app.run_on_main_thread({
                        let window = window.clone();
                        let app = app.clone();
                        let panel_activation_guard = panel_activation_guard;
                        move || {
                            let _panel_activation_guard = panel_activation_guard;
                            use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
                            use tauri_nspanel::panel_delegate;
                            use crate::panel_manager::try_to_panel;

                            let delegate = panel_delegate!(MainPanelDelegate {
                                window_did_become_key,
                                window_did_resign_key
                            });

                            delegate.set_listener(Box::new(|_delegate_name: String| {}));

                            let panel = match try_to_panel(&window) {
                                Ok(p) => p,
                                Err(e) => {
                                    tracing::error!("Failed to convert main window to panel: {}", e);
                                    crate::permissions::sync_macos_dock_visibility(&app);
                                    return;
                                }
                            };

                            panel.set_collection_behaviour(
                                NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenPrimary,
                            );

                            panel.set_delegate(delegate);

                            panel.set_level(MAIN_PANEL_LEVEL);

                            let _ = window.set_position(main_position);

                            crate::platform::apply_squircle_corners(&window, 16.0);

                            crate::permissions::schedule_macos_dock_visibility_sync(&app);
                        }
                    })
                    .ok();
                }

                #[cfg(not(target_os = "macos"))]
                {
                    let _ = window.set_position(main_position);

                    #[cfg(windows)]
                    {
                        if let Err(e) = window.set_size(LogicalSize::new(330.0, 395.0)) {
                            warn!("Failed to set Main window size on Windows: {}", e);
                        }
                        if let Err(e) = window.set_position(main_position) {
                            warn!("Failed to position Main window on Windows: {}", e);
                        }
                    }

                    window.show().ok();
                }

                window
            }
            Self::TargetSelectOverlay {
                display_id,
                target_mode,
            } => {
                let Some(display) = scap_targets::Display::from_id(display_id) else {
                    return Err(tauri::Error::WindowNotFound);
                };
                let is_hovered_display = scap_targets::Display::get_containing_cursor()
                    .map(|d| d.id())
                    == Some(display.id());

                let title = CapWindowId::TargetSelectOverlay {
                    display_id: display_id.clone(),
                }
                .title();
                let should_protect = should_protect_window(app, &title);

                let target_mode_param = match target_mode {
                    Some(RecordingTargetMode::Display) => "&targetMode=display",
                    Some(RecordingTargetMode::Window) => "&targetMode=window",
                    Some(RecordingTargetMode::Area) => "&targetMode=area",
                    Some(RecordingTargetMode::Camera) => "&targetMode=camera",
                    None => "",
                };

                let camera_ws_port = {
                    let Some(state) = app.try_state::<ArcLock<App>>() else {
                        warn!("App state unavailable during target select overlay creation");
                        return Err(tauri::Error::WindowNotFound);
                    };
                    let state = state.read().await;
                    state.camera_ws_port
                };

                #[cfg(target_os = "macos")]
                let panel_activation_guard = permissions::prepare_macos_panel_window(app);

                let mut window_builder = self
                    .window_builder(
                        app,
                        format!("/target-select-overlay?displayId={display_id}&isHoveredDisplay={is_hovered_display}{target_mode_param}"),
                    )
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .content_protected(should_protect)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .skip_taskbar(true)
                    .transparent(true)
                    .visible(false)
                    .initialization_script(format!(
                        "window.__CAP__ = window.__CAP__ ?? {{}}; window.__CAP__.cameraWsPort = {camera_ws_port};"
                    ));

                #[cfg(target_os = "macos")]
                {
                    let position = display.raw_handle().logical_position();
                    let size = display.logical_size().unwrap();

                    window_builder = window_builder
                        .inner_size(size.width(), size.height())
                        .position(position.x(), position.y());
                }

                #[cfg(windows)]
                {
                    window_builder = window_builder.inner_size(100.0, 100.0).position(0.0, 0.0);
                }

                #[cfg(target_os = "linux")]
                {
                    let position = display.raw_handle().physical_position().unwrap();
                    let size = display.physical_size().unwrap();
                    window_builder = window_builder
                        .inner_size(size.width(), size.height())
                        .position(position.x(), position.y());
                }

                let window = window_builder.build()?;
                lock_window_text_scale(&window);

                #[cfg(target_os = "linux")]
                {
                    use tauri::{LogicalSize, PhysicalPosition};
                    let position = display.raw_handle().physical_position().unwrap();
                    let size = display.physical_size().unwrap();
                    let _ = window.set_position(PhysicalPosition::new(position.x(), position.y()));
                    let _ = window.set_size(LogicalSize::new(size.width(), size.height()));
                }

                #[cfg(windows)]
                {
                    let Some(position) = display.raw_handle().physical_position() else {
                        warn!(display_id = %display_id, "Missing display position for target select overlay");
                        return Err(tauri::Error::WindowNotFound);
                    };
                    let Some(logical_size) = display.logical_size() else {
                        warn!(display_id = %display_id, "Missing display logical size for target select overlay");
                        return Err(tauri::Error::WindowNotFound);
                    };
                    let Some(physical_size) = display.physical_size() else {
                        warn!(display_id = %display_id, "Missing display physical size for target select overlay");
                        return Err(tauri::Error::WindowNotFound);
                    };
                    use tauri::{LogicalSize, PhysicalPosition, PhysicalSize};
                    let _ = window.set_size(LogicalSize::new(
                        logical_size.width(),
                        logical_size.height(),
                    ));
                    let _ = window.set_position(PhysicalPosition::new(position.x(), position.y()));
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

                    match window.inner_size() {
                        Ok(actual_physical_size)
                            if physical_size.width() != actual_physical_size.width as f64 =>
                        {
                            let _ = window.set_size(LogicalSize::new(
                                logical_size.width(),
                                logical_size.height(),
                            ));
                        }
                        Ok(_) => {}
                        Err(err) => {
                            warn!(%err, "Failed to read target select overlay inner size");
                        }
                    }
                }

                app.state::<WindowFocusManager>()
                    .spawn(display_id, window.clone());

                #[cfg(target_os = "macos")]
                {
                    app.run_on_main_thread({
                        let window = window.clone();
                        let app = app.clone();
                        let panel_activation_guard = panel_activation_guard;
                        move || {
                            let _panel_activation_guard = panel_activation_guard;
                            use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
                            use tauri_nspanel::panel_delegate;
                            use tauri_nspanel::WebviewWindowExt as NSPanelWebviewWindowExt;

                            #[link(name = "CoreGraphics", kind = "framework")]
                            unsafe extern "C" {
                                fn CGWindowLevelForKey(key: i32) -> i32;
                            }

                            #[allow(non_upper_case_globals)]
                            const kCGMaximumWindowLevelKey: i32 = 10;

                            let delegate = panel_delegate!(TargetSelectOverlayPanelDelegate {
                                window_did_become_key,
                                window_did_resign_key
                            });

                            delegate.set_listener(Box::new(|_delegate_name: String| {}));

                            let panel = match window.to_panel() {
                                Ok(p) => p,
                                Err(e) => {
                                    tracing::error!("Failed to convert target select overlay to panel: {:?}", e);
                                    crate::permissions::sync_macos_dock_visibility(&app);
                                    return;
                                }
                            };

                            panel.set_collection_behaviour(
                                NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenPrimary,
                            );

                            panel.set_delegate(delegate);

                            #[allow(non_upper_case_globals)]
                            const NSWindowStyleMaskNonActivatingPanel: i32 = 1 << 7;
                            panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel);

                            let max_level = unsafe { CGWindowLevelForKey(kCGMaximumWindowLevelKey) };
                            panel.set_level(max_level - 1);

                            panel.order_front_regardless();
                            panel.show();

                            crate::permissions::schedule_macos_dock_visibility_sync(&app);
                        }
                    })
                    .ok();
                }

                #[cfg(not(target_os = "macos"))]
                {
                    window.show().ok();
                }

                window
            }
            Self::Settings { page } => {
                let mut builder = self
                    .window_builder(
                        app,
                        format!("/settings/{}", page.clone().unwrap_or_default()),
                    )
                    .inner_size(782.0, 775.0)
                    .min_inner_size(780.0, 560.0)
                    .resizable(true)
                    .maximized(false)
                    .focused(true);

                #[cfg(target_os = "macos")]
                {
                    builder = builder.transparent(true);
                }

                let window = builder.build()?;
                lock_window_text_scale(&window);

                let (pos_x, pos_y) = cursor_monitor.center_position(782.0, 775.0);
                let _ = window.set_position(cursor_monitor.position(pos_x, pos_y));

                #[cfg(windows)]
                {
                    if let Err(e) = window.set_size(LogicalSize::new(782.0, 775.0)) {
                        warn!("Failed to set Settings window size on Windows: {}", e);
                    }
                    if let Err(e) = window.set_position(cursor_monitor.position(pos_x, pos_y)) {
                        warn!("Failed to position Settings window on Windows: {}", e);
                    }
                }

                ensure_settings_window_bounds(&window);

                window
            }
            Self::Editor { .. } => {
                let open_started = std::time::Instant::now();
                hide_recording_windows(app, false);
                release_camera_preview_if_idle(app);

                let window = match self
                    .window_builder(app, "/editor")
                    .maximizable(true)
                    .inner_size(1275.0, 800.0)
                    .min_inner_size(1275.0, 800.0)
                    .focused(true)
                    .build()
                {
                    Ok(window) => window,
                    Err(error) => {
                        // Don't leave the prewarmed instance (decoders, frame
                        // websocket) orphaned if the window failed to appear.
                        let window_label = self.id(app).label();
                        PendingEditorInstances::get(app)
                            .cancel_prewarm(&window_label)
                            .await;
                        return Err(error);
                    }
                };
                lock_window_text_scale(&window);

                let (pos_x, pos_y) = cursor_monitor.center_position(1275.0, 800.0);
                let _ = window.set_position(cursor_monitor.position(pos_x, pos_y));

                #[cfg(windows)]
                {
                    use tauri::LogicalSize;
                    if let Err(e) = window.set_size(LogicalSize::new(1275.0, 800.0)) {
                        warn!("Failed to set Editor window size on Windows: {}", e);
                    }
                    if let Err(e) = window.set_position(cursor_monitor.position(pos_x, pos_y)) {
                        warn!("Failed to position Editor window on Windows: {}", e);
                    }
                }

                // Show immediately: the native background color is already
                // themed, so the window can appear before the webview loads and
                // the editor skeleton takes over. When window transparency is
                // enabled we keep the old behaviour (the frontend reveals the
                // window after applying the HudWindow effects) to avoid an
                // opaque-to-transparent pop.
                let transparency_enabled = GeneralSettingsStore::get(app)
                    .ok()
                    .flatten()
                    .map(|s| s.window_transparency)
                    .unwrap_or(false);
                if !transparency_enabled {
                    window.show().ok();
                    window.set_focus().ok();
                }

                info!(
                    window_built_and_shown_ms = open_started.elapsed().as_millis() as u64,
                    shown_from_rust = !transparency_enabled,
                    "Editor open: window ready"
                );

                window
            }
            Self::ScreenshotEditor { path } => {
                hide_recording_windows(app, false);
                release_camera_preview_if_idle(app);

                let window_label = self.id(app).label();
                let pending = PendingScreenshotEditorInstances::get(app);
                PendingScreenshotEditorInstances::start_prewarm(
                    app,
                    window_label.clone(),
                    path.clone(),
                )
                .await;

                let window = match self
                    .window_builder(app, "/screenshot-editor")
                    .maximizable(true)
                    .inner_size(1240.0, 800.0)
                    .min_inner_size(800.0, 600.0)
                    .focused(true)
                    .build()
                {
                    Ok(window) => window,
                    Err(error) => {
                        pending.cancel_prewarm(&window_label).await;
                        return Err(error);
                    }
                };
                lock_window_text_scale(&window);

                let (pos_x, pos_y) = cursor_monitor.center_position(1240.0, 800.0);
                let _ = window.set_position(cursor_monitor.position(pos_x, pos_y));

                #[cfg(windows)]
                {
                    use tauri::LogicalSize;
                    if let Err(e) = window.set_size(LogicalSize::new(1240.0, 800.0)) {
                        warn!(
                            "Failed to set ScreenshotEditor window size on Windows: {}",
                            e
                        );
                    }
                    if let Err(e) = window.set_position(cursor_monitor.position(pos_x, pos_y)) {
                        warn!(
                            "Failed to position ScreenshotEditor window on Windows: {}",
                            e
                        );
                    }
                }

                window.show().ok();
                window.set_focus().ok();

                window
            }
            Self::Upgrade => {
                if let Some(main) = CapWindowId::Main.get(app) {
                    let _ = main.hide();
                }

                let window = self
                    .window_builder(app, "/upgrade")
                    .inner_size(950.0, 850.0)
                    .min_inner_size(950.0, 850.0)
                    .resizable(false)
                    .focused(true)
                    .always_on_top(true)
                    .maximized(false)
                    .shadow(true)
                    .build()?;
                lock_window_text_scale(&window);

                let (pos_x, pos_y) = cursor_monitor.center_position(950.0, 850.0);
                let _ = window.set_position(cursor_monitor.position(pos_x, pos_y));

                #[cfg(windows)]
                {
                    use tauri::LogicalSize;
                    if let Err(e) = window.set_size(LogicalSize::new(950.0, 850.0)) {
                        warn!("Failed to set Upgrade window size on Windows: {}", e);
                    }
                    if let Err(e) = window.set_position(cursor_monitor.position(pos_x, pos_y)) {
                        warn!("Failed to position Upgrade window on Windows: {}", e);
                    }
                }

                window.show().ok();
                window.set_focus().ok();

                window
            }
            Self::ModeSelect => {
                if let Some(main) = CapWindowId::Main.get(app) {
                    let _ = main.hide();
                }

                let window = self
                    .window_builder(app, "/mode-select")
                    .inner_size(580.0, 340.0)
                    .min_inner_size(580.0, 340.0)
                    .resizable(false)
                    .maximized(false)
                    .maximizable(false)
                    .focused(true)
                    .shadow(true)
                    .build()?;
                lock_window_text_scale(&window);

                let (pos_x, pos_y) = cursor_monitor.center_position(580.0, 340.0);
                let _ = window.set_position(cursor_monitor.position(pos_x, pos_y));

                #[cfg(windows)]
                {
                    use tauri::LogicalSize;
                    if let Err(e) = window.set_size(LogicalSize::new(580.0, 340.0)) {
                        warn!("Failed to set ModeSelect window size on Windows: {}", e);
                    }
                    if let Err(e) = window.set_position(cursor_monitor.position(pos_x, pos_y)) {
                        warn!("Failed to position ModeSelect window on Windows: {}", e);
                    }
                }

                window.show().ok();
                window.set_focus().ok();

                window
            }
            Self::Onboarding => {
                if let Some(main) = CapWindowId::Main.get(app) {
                    let _ = main.hide();
                }

                let width = (cursor_monitor.width * 0.58).clamp(860.0, 1080.0);
                let height = (width * 0.72).clamp(690.0, 780.0);

                let window = self
                    .window_builder(app, "/onboarding")
                    .inner_size(width, height)
                    .min_inner_size(860.0, 690.0)
                    .resizable(false)
                    .maximized(false)
                    .maximizable(false)
                    .transparent(true)
                    .focused(true)
                    .shadow(true)
                    .build()?;
                lock_window_text_scale(&window);

                let (pos_x, pos_y) = cursor_monitor.center_position(width, height);
                let _ = window.set_position(cursor_monitor.position(pos_x, pos_y));
                let _ = window.set_ignore_cursor_events(false);

                #[cfg(windows)]
                {
                    use tauri::LogicalSize;
                    if let Err(e) = window.set_size(LogicalSize::new(width, height)) {
                        warn!("Failed to set Onboarding window size on Windows: {}", e);
                    }
                    if let Err(e) = window.set_position(cursor_monitor.position(pos_x, pos_y)) {
                        warn!("Failed to position Onboarding window on Windows: {}", e);
                    }
                }

                window.show().ok();
                window.set_focus().ok();

                window
            }
            Self::Camera { centered } => {
                const DEFAULT_WINDOW_SIZE: f64 = 230.0 * 2.0;
                const CENTERED_WINDOW_SIZE: f64 = 400.0;

                #[cfg(target_os = "macos")]
                let create_guard = {
                    let panel_manager = app.state::<PanelManager>();
                    panel_manager
                        .try_begin_create(PanelWindowType::Camera)
                        .await
                };

                #[cfg(target_os = "macos")]
                let Some(mut create_guard) = create_guard else {
                    let panel_manager = app.state::<PanelManager>();
                    let state = panel_manager.get_state(PanelWindowType::Camera).await;
                    warn!("Camera window creation blocked, current state: {:?}", state);
                    if state == PanelState::Ready
                        && let Some(window) = CapWindowId::Camera.get(app)
                    {
                        if *centered {
                            center_camera_window(app, &window);
                        }
                        return Ok(window);
                    }
                    panel_manager
                        .wait_for_state(
                            PanelWindowType::Camera,
                            &[PanelState::Ready, PanelState::None],
                            std::time::Duration::from_millis(500),
                        )
                        .await;
                    if let Some(window) = CapWindowId::Camera.get(app) {
                        if *centered {
                            center_camera_window(app, &window);
                        }
                        return Ok(window);
                    }
                    return Err(tauri::Error::WindowNotFound);
                };

                let enable_native_camera_preview =
                    GeneralSettingsStore::native_camera_preview_enabled(app);

                {
                    let Some(state) = app.try_state::<ArcLock<App>>() else {
                        warn!("App state unavailable while creating camera window");
                        return Err(tauri::Error::WindowNotFound);
                    };
                    let mut state = state.write().await;

                    let shutdown_preview =
                        if !enable_native_camera_preview && state.camera_preview.is_initialized() {
                            state.camera_preview.begin_shutdown()
                        } else {
                            None
                        };

                    if enable_native_camera_preview && state.camera_preview.is_initialized() {
                        warn!("Detected existing camera preview, will reuse it");
                    }

                    // Camera protection is applied per recording mode in `start_recording`;
                    // protecting at creation hides the live preview on virtual/mirrored displays.
                    let should_protect = false;

                    #[cfg(target_os = "macos")]
                    let panel_activation_guard = permissions::prepare_macos_panel_window(app);

                    let label = camera_window_label
                        .clone()
                        .unwrap_or_else(|| CapWindowId::Camera.label());
                    let mut window_builder = self
                        .window_builder_with_label(app, "/camera", label)
                        .maximized(false)
                        .resizable(false)
                        .shadow(false)
                        .fullscreen(false)
                        .always_on_top(true)
                        .visible_on_all_workspaces(true)
                        .skip_taskbar(true)
                        .initialization_script(format!(
                            "
			                window.__CAP__ = window.__CAP__ ?? {{}};
			                window.__CAP__.cameraWsPort = {};
			                window.__CAP__.cameraOnlyMode = {};
			                window.__CAP__.enableNativeCameraPreview = {};
		                ",
                            state.camera_ws_port, centered, enable_native_camera_preview
                        ))
                        .content_protected(should_protect)
                        .transparent(true)
                        .visible(false);

                    let window = match window_builder.build() {
                        Ok(w) => w,
                        Err(e) => {
                            let is_label_exists = e.to_string().contains("already exists");
                            if is_label_exists {
                                warn!(
                                    "Camera webview label already exists, cleaning up for next attempt"
                                );
                                cleanup_camera_window(app, None, false, false).await;
                            }

                            #[cfg(target_os = "macos")]
                            {
                                let panel_manager = app.state::<PanelManager>();
                                panel_manager.force_reset(PanelWindowType::Camera).await;
                            }
                            return Err(e);
                        }
                    };
                    lock_window_text_scale(&window);

                    #[cfg(target_os = "windows")]
                    log_window_content_protection(
                        &window,
                        should_protect,
                        &CapWindowId::Camera.title(),
                    );

                    let camera_monitor = CapWindowId::Main
                        .get(app)
                        .map(|w| CursorMonitorInfo::from_window(&w))
                        .unwrap_or(cursor_monitor);

                    let preferred_monitor_name = display_name_for_position(
                        camera_monitor.x + camera_monitor.width / 2.0,
                        camera_monitor.y + camera_monitor.height / 2.0,
                    );

                    let saved_position =
                        GeneralSettingsStore::get(app)
                            .ok()
                            .flatten()
                            .and_then(|settings| {
                                if let Some(monitor_name) = preferred_monitor_name.as_deref() {
                                    settings
                                        .camera_window_positions_by_monitor_name
                                        .get(monitor_name)
                                        .cloned()
                                        .filter(|pos| {
                                            is_position_on_monitor_name(monitor_name, pos.x, pos.y)
                                        })
                                        .or_else(|| {
                                            settings.camera_window_position.filter(|pos| {
                                                is_position_on_monitor_name(
                                                    monitor_name,
                                                    pos.x,
                                                    pos.y,
                                                )
                                            })
                                        })
                                } else {
                                    settings.camera_window_position.filter(|pos| {
                                        if let Some(display_id) = &pos.display_id {
                                            is_position_on_display(display_id, pos.x, pos.y)
                                        } else {
                                            is_position_on_any_screen(pos.x, pos.y)
                                        }
                                    })
                                }
                            });

                    let camera_position = if let Some(pos) = saved_position {
                        match display_for_saved_position(pos.x, pos.y, pos.display_id.as_ref()) {
                            Some(display) => {
                                CursorMonitorInfo::from_display(&display).position(pos.x, pos.y)
                            }
                            None => {
                                tauri::Position::Logical(tauri::LogicalPosition::new(pos.x, pos.y))
                            }
                        }
                    } else if *centered {
                        let aspect_ratio = crate::camera::WIDE_CAMERA_ASPECT_RATIO as f64;
                        let toolbar_height = 56.0;
                        let window_width = CENTERED_WINDOW_SIZE * aspect_ratio;
                        let window_height = CENTERED_WINDOW_SIZE + toolbar_height;
                        let (camera_pos_x, camera_pos_y) =
                            camera_monitor.center_position(window_width, window_height);
                        camera_monitor.position(camera_pos_x, camera_pos_y)
                    } else {
                        let camera_pos_x =
                            camera_monitor.x + camera_monitor.width - DEFAULT_WINDOW_SIZE - 100.0;
                        let camera_pos_y =
                            camera_monitor.y + camera_monitor.height - DEFAULT_WINDOW_SIZE - 100.0;
                        camera_monitor.position(camera_pos_x, camera_pos_y)
                    };

                    #[cfg(not(target_os = "macos"))]
                    {
                        if let Some(guard) = app.try_state::<CameraWindowPositionGuard>() {
                            guard.ignore_for(1000);
                        }
                        let _ = window.set_position(camera_position);
                    }

                    ensure_camera_input_active(&mut state).await;

                    #[cfg(target_os = "macos")]
                    {
                        let panel_manager = app.state::<PanelManager>();
                        let operation_id = create_guard.operation_id;

                        let (panel_tx, panel_rx) = tokio::sync::oneshot::channel();
                        app.run_on_main_thread({
                            let window = window.clone();
                            let app = app.clone();
                            let panel_activation_guard = panel_activation_guard;
                            move || {
                                let _panel_activation_guard = panel_activation_guard;
                                use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
                                use tauri_nspanel::panel_delegate;
                                use crate::panel_manager::try_to_panel;

                                #[link(name = "CoreGraphics", kind = "framework")]
                                unsafe extern "C" {
                                    fn CGWindowLevelForKey(key: i32) -> i32;
                                }

                                #[allow(non_upper_case_globals)]
                                const kCGMaximumWindowLevelKey: i32 = 10;

                                let delegate = panel_delegate!(CameraPanelDelegate {
                                    window_did_become_key,
                                    window_did_resign_key
                                });

                                delegate.set_listener(Box::new(|_delegate_name: String| {}));

                                let panel = match try_to_panel(&window) {
                                    Ok(p) => p,
                                    Err(e) => {
                                        tracing::error!("Failed to convert camera to panel: {}", e);
                                        crate::permissions::sync_macos_dock_visibility(&app);
                                        let _ = panel_tx.send(false);
                                        return;
                                    }
                                };

                                panel.set_collection_behaviour(
                                    NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                        | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenPrimary,
                                );

                                panel.set_delegate(delegate);

                                let max_level =
                                    unsafe { CGWindowLevelForKey(kCGMaximumWindowLevelKey) };
                                panel.set_level(max_level);

                                if let Some(guard) = app.try_state::<CameraWindowPositionGuard>() {
                                    guard.ignore_for(1000);
                                }
                                let _ = window.set_position(camera_position);

                                panel.order_front_regardless();
                                panel.show();
                                crate::permissions::schedule_macos_dock_visibility_sync(&app);
                                let _ = panel_tx.send(true);
                            }
                        })
                        .ok();

                        if panel_rx.await.unwrap_or(false) {
                            panel_manager
                                .mark_ready(PanelWindowType::Camera, operation_id)
                                .await;
                            create_guard.mark_completed();
                        } else {
                            warn!("Camera panel creation failed");
                            panel_manager.force_reset(PanelWindowType::Camera).await;
                        }
                    }

                    if enable_native_camera_preview
                        && let Err(err) =
                            init_native_camera_preview(&mut state, window.clone()).await
                    {
                        error!(
                            "Error initializing camera preview, falling back to WebSocket preview: {err}"
                        );
                    }

                    #[cfg(not(target_os = "macos"))]
                    {
                        window.show().ok();
                    }

                    drop(state);

                    if let Some(rx) = shutdown_preview {
                        let _ = tokio::time::timeout(Duration::from_millis(500), rx).await;
                    }

                    window
                }
            }
            Self::WindowCaptureOccluder { screen_id } => {
                let Some(display) = Display::from_id(screen_id) else {
                    return Err(tauri::Error::WindowNotFound);
                };

                let title = CapWindowId::WindowCaptureOccluder {
                    screen_id: screen_id.clone(),
                }
                .title();
                let should_protect = should_protect_window(app, &title);

                let mut window_builder = self
                    .window_builder(app, "/window-capture-occluder")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .content_protected(should_protect)
                    .skip_taskbar(true)
                    .transparent(true);

                #[cfg(target_os = "macos")]
                {
                    let position = display.raw_handle().logical_position();
                    let Some(size) = display.logical_size() else {
                        warn!(screen_id = %screen_id, "Missing display logical size for window capture occluder");
                        return Err(tauri::Error::WindowNotFound);
                    };

                    window_builder = window_builder
                        .inner_size(size.width(), size.height())
                        .position(position.x(), position.y());
                }

                // On Windows a window's DPI scale isn't known until it's placed on a
                // monitor, so sizing/positioning from display bounds at build time is
                // unreliable across monitors with different DPIs. Build a placeholder
                // and fix the geometry up after the window exists (below), mirroring
                // the TargetSelectOverlay path.
                #[cfg(windows)]
                {
                    window_builder = window_builder.inner_size(100.0, 100.0).position(0.0, 0.0);
                }

                #[cfg(target_os = "linux")]
                {
                    let position = display.raw_handle().physical_position().unwrap();
                    let Some(size) = display.physical_size() else {
                        warn!(screen_id = %screen_id, "Missing display size for window capture occluder");
                        return Err(tauri::Error::WindowNotFound);
                    };
                    window_builder = window_builder
                        .inner_size(size.width(), size.height())
                        .position(position.x(), position.y());
                }

                let window = window_builder.build()?;
                lock_window_text_scale(&window);

                #[cfg(target_os = "linux")]
                {
                    use tauri::{LogicalSize, PhysicalPosition};
                    let position = display.raw_handle().physical_position().unwrap();
                    if let Some(size) = display.physical_size() {
                        let _ =
                            window.set_position(PhysicalPosition::new(position.x(), position.y()));
                        let _ = window.set_size(LogicalSize::new(size.width(), size.height()));
                    }
                }

                // Fix up the occluder geometry now that the window exists and its real
                // per-monitor DPI is known: position with physical coordinates (which
                // are unambiguous across monitors), then set the logical size so the
                // window covers the full display. Verify the resulting physical size
                // matches the display and re-apply once if the initial placement raced
                // the DPI change.
                #[cfg(windows)]
                {
                    let Some(position) = display.raw_handle().physical_position() else {
                        warn!(screen_id = %screen_id, "Missing display position for window capture occluder");
                        return Err(tauri::Error::WindowNotFound);
                    };
                    let Some(logical_size) = display.logical_size() else {
                        warn!(screen_id = %screen_id, "Missing display logical size for window capture occluder");
                        return Err(tauri::Error::WindowNotFound);
                    };
                    let Some(physical_size) = display.physical_size() else {
                        warn!(screen_id = %screen_id, "Missing display physical size for window capture occluder");
                        return Err(tauri::Error::WindowNotFound);
                    };
                    use tauri::{LogicalSize, PhysicalPosition};
                    let _ = window.set_size(LogicalSize::new(
                        logical_size.width(),
                        logical_size.height(),
                    ));
                    let _ = window.set_position(PhysicalPosition::new(position.x(), position.y()));
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

                    match window.inner_size() {
                        Ok(actual_physical_size)
                            if physical_size.width() != actual_physical_size.width as f64 =>
                        {
                            let _ = window.set_size(LogicalSize::new(
                                logical_size.width(),
                                logical_size.height(),
                            ));
                        }
                        Ok(_) => {}
                        Err(err) => {
                            warn!(%err, "Failed to read window capture occluder inner size");
                        }
                    }
                }

                if let Err(err) = window.set_ignore_cursor_events(true) {
                    warn!(%err, "Failed to ignore cursor events for window capture occluder");
                }

                #[cfg(target_os = "macos")]
                {
                    crate::platform::set_window_level(window.as_ref().window(), 900);
                }

                window
            }
            Self::CaptureArea { screen_id } => {
                let title = CapWindowId::CaptureArea.title();
                let should_protect = should_protect_window(app, &title);

                let mut window_builder = self
                    .window_builder(app, "/capture-area")
                    .maximized(false)
                    .fullscreen(false)
                    .shadow(false)
                    .resizable(false)
                    .always_on_top(true)
                    .content_protected(should_protect)
                    .skip_taskbar(true)
                    .closable(true)
                    .decorations(false)
                    .transparent(true);

                let Some(display) = Display::from_id(screen_id) else {
                    return Err(tauri::Error::WindowNotFound);
                };

                #[cfg(target_os = "macos")]
                if let Some(bounds) = display.raw_handle().logical_bounds() {
                    window_builder = window_builder
                        .inner_size(bounds.size().width(), bounds.size().height())
                        .position(bounds.position().x(), bounds.position().y());
                }

                // On Windows a window's DPI scale isn't known until it's placed on a
                // monitor, so sizing/positioning from logical bounds at build time is
                // unreliable across monitors with different DPIs — the overlay ends up
                // sized for the wrong monitor and no longer covers the target display,
                // which truncates area selections on HiDPI secondary monitors. Build a
                // placeholder and fix the geometry up after the window exists (below),
                // mirroring the TargetSelectOverlay path.
                #[cfg(windows)]
                {
                    window_builder = window_builder.inner_size(100.0, 100.0).position(0.0, 0.0);
                }

                #[cfg(target_os = "linux")]
                if let Some(bounds) = display.raw_handle().physical_bounds() {
                    window_builder = window_builder
                        .inner_size(bounds.size().width(), bounds.size().height())
                        .position(bounds.position().x(), bounds.position().y());
                }

                let window = window_builder.build()?;
                lock_window_text_scale(&window);

                // Fix up the overlay geometry now that the window exists and its real
                // per-monitor DPI is known: position with physical coordinates (which are
                // unambiguous across monitors), then set the logical size so the window
                // covers the full display. Verify the resulting physical size matches the
                // display and re-apply once if the initial placement raced the DPI change.
                #[cfg(windows)]
                {
                    let Some(position) = display.raw_handle().physical_position() else {
                        warn!(display_id = %screen_id, "Missing display position for capture area overlay");
                        return Err(tauri::Error::WindowNotFound);
                    };
                    let Some(logical_size) = display.logical_size() else {
                        warn!(display_id = %screen_id, "Missing display logical size for capture area overlay");
                        return Err(tauri::Error::WindowNotFound);
                    };
                    let Some(physical_size) = display.physical_size() else {
                        warn!(display_id = %screen_id, "Missing display physical size for capture area overlay");
                        return Err(tauri::Error::WindowNotFound);
                    };
                    use tauri::{LogicalSize, PhysicalPosition};
                    let _ = window.set_size(LogicalSize::new(
                        logical_size.width(),
                        logical_size.height(),
                    ));
                    let _ = window.set_position(PhysicalPosition::new(position.x(), position.y()));
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

                    match window.inner_size() {
                        Ok(actual_physical_size)
                            if physical_size.width() != actual_physical_size.width as f64 =>
                        {
                            let _ = window.set_size(LogicalSize::new(
                                logical_size.width(),
                                logical_size.height(),
                            ));
                        }
                        Ok(_) => {}
                        Err(err) => {
                            warn!(%err, "Failed to read capture area overlay inner size");
                        }
                    }
                }

                #[cfg(target_os = "linux")]
                if let Some(bounds) = display.raw_handle().physical_bounds() {
                    use tauri::{LogicalSize, PhysicalPosition};
                    let _ = window.set_position(PhysicalPosition::new(
                        bounds.position().x(),
                        bounds.position().y(),
                    ));
                    let _ = window.set_size(LogicalSize::new(
                        bounds.size().width(),
                        bounds.size().height(),
                    ));
                }

                #[cfg(target_os = "macos")]
                crate::platform::set_window_level(
                    window.as_ref().window(),
                    objc2_app_kit::NSPopUpMenuWindowLevel,
                );

                // Hide the main window if the target monitor is the same
                if let Some(main_window) = CapWindowId::Main.get(app)
                    && let (Ok(outer_pos), Ok(outer_size)) =
                        (main_window.outer_position(), main_window.outer_size())
                    && let Ok(scale_factor) = main_window.scale_factor()
                    && display.intersects(outer_pos, outer_size, scale_factor)
                {
                    let _ = main_window.minimize();
                };

                window
            }
            Self::InProgressRecording {
                countdown,
                capture_target,
            } => {
                let width = 320.0;
                let height = 150.0;

                let title = CapWindowId::RecordingControls.title();
                let should_protect = should_protect_window(app, &title);

                #[cfg(target_os = "macos")]
                let panel_activation_guard = permissions::prepare_macos_panel_window(app);

                #[cfg(target_os = "macos")]
                let window = {
                    self.window_builder(app, "/in-progress-recording")
                        .maximized(false)
                        .resizable(false)
                        .fullscreen(false)
                        .shadow(false)
                        .always_on_top(true)
                        .transparent(true)
                        .visible_on_all_workspaces(true)
                        .content_protected(should_protect)
                        .inner_size(width, height)
                        .skip_taskbar(true)
                        .visible(false)
                        .initialization_script(format!(
                            "window.COUNTDOWN = {};",
                            countdown.unwrap_or_default()
                        ))
                        .build()?
                };

                #[cfg(windows)]
                let window = self
                    .window_builder(app, "/in-progress-recording")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(true)
                    .transparent(true)
                    .visible_on_all_workspaces(true)
                    .content_protected(should_protect)
                    .inner_size(width, height)
                    .skip_taskbar(false)
                    .initialization_script(format!(
                        "window.COUNTDOWN = {};",
                        countdown.unwrap_or_default()
                    ))
                    .build()?;

                #[cfg(target_os = "linux")]
                let window = self
                    .window_builder(app, "/in-progress-recording")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(true)
                    .transparent(true)
                    .visible_on_all_workspaces(true)
                    .content_protected(should_protect)
                    .inner_size(width, height)
                    .skip_taskbar(false)
                    .initialization_script(format!(
                        "window.COUNTDOWN = {};",
                        countdown.unwrap_or_default()
                    ))
                    .build()?;

                lock_window_text_scale(&window);

                #[cfg(target_os = "windows")]
                log_window_content_protection(&window, should_protect, &title);

                let (pos_x, pos_y) = capture_target
                    .as_ref()
                    .and_then(fake_window::calculate_recording_controls_position_for_target)
                    .unwrap_or_else(|| cursor_monitor.bottom_center_position(width, height, 120.0));
                let _ = window.set_position(logical_point_position(pos_x, pos_y));

                debug!(
                    "InProgressRecording window: cursor_monitor=({}, {}, {}, {}), pos=({}, {})",
                    cursor_monitor.x,
                    cursor_monitor.y,
                    cursor_monitor.width,
                    cursor_monitor.height,
                    pos_x,
                    pos_y
                );

                debug!(
                    "InProgressRecording window created: label={}, inner_size={:?}, outer_position={:?}",
                    window.label(),
                    window.inner_size(),
                    window.outer_position()
                );

                #[cfg(target_os = "macos")]
                {
                    app.run_on_main_thread({
                        let window = window.clone();
                        let app = app.clone();
                        let panel_activation_guard = panel_activation_guard;
                        move || {
                            let _panel_activation_guard = panel_activation_guard;
                            use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
                            use tauri_nspanel::panel_delegate;
                            use tauri_nspanel::WebviewWindowExt as NSPanelWebviewWindowExt;

                            #[link(name = "CoreGraphics", kind = "framework")]
                            unsafe extern "C" {
                                fn CGWindowLevelForKey(key: i32) -> i32;
                            }

                            #[allow(non_upper_case_globals)]
                            const kCGMaximumWindowLevelKey: i32 = 10;

                            let delegate = panel_delegate!(RecordingControlsPanelDelegate {
                                window_did_become_key,
                                window_did_resign_key
                            });

                            delegate.set_listener(Box::new(|_delegate_name: String| {}));

                            let panel = match window.to_panel() {
                                Ok(p) => p,
                                Err(e) => {
                                    tracing::error!("Failed to convert recording controls to panel: {:?}", e);
                                    crate::permissions::sync_macos_dock_visibility(&app);
                                    return;
                                }
                            };

                            panel.set_collection_behaviour(
                                NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenPrimary,
                            );

                            panel.set_delegate(delegate);

                            let max_level = unsafe { CGWindowLevelForKey(kCGMaximumWindowLevelKey) };
                            panel.set_level(max_level);

                            panel.order_front_regardless();
                            panel.show();

                            crate::permissions::schedule_macos_dock_visibility_sync(&app);
                        }
                    })
                    .ok();

                    fake_window::spawn_fake_window_listener(app.clone(), window.clone());
                }

                #[cfg(windows)]
                {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    let show_result = window.show();
                    debug!(
                        "InProgressRecording window.show() result: {:?}",
                        show_result
                    );
                    window.set_focus().ok();
                    fake_window::spawn_fake_window_listener(app.clone(), window.clone());
                }

                window
            }
            Self::RecordingsOverlay => {
                let title = CapWindowId::RecordingsOverlay.title();
                let should_protect = should_protect_window(app, &title);

                let window = self
                    .window_builder(app, "/recordings-overlay")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .accept_first_mouse(true)
                    .content_protected(should_protect)
                    .inner_size(cursor_monitor.width, cursor_monitor.height)
                    .skip_taskbar(true)
                    .transparent(true)
                    .build()?;
                lock_window_text_scale(&window);

                let _ = window
                    .set_position(cursor_monitor.position(cursor_monitor.x, cursor_monitor.y));

                // The build-time inner_size above was interpreted with the DPI of
                // whatever monitor the window materialized on; now that it sits on the
                // cursor monitor, re-apply the logical size so it converts with that
                // monitor's scale, then verify against the expected physical size.
                #[cfg(windows)]
                {
                    let _ = window.set_size(LogicalSize::new(
                        cursor_monitor.width,
                        cursor_monitor.height,
                    ));
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

                    let expected_physical_width =
                        (cursor_monitor.width * cursor_monitor.scale).round();
                    match window.inner_size() {
                        Ok(actual_physical_size)
                            if expected_physical_width != actual_physical_size.width as f64 =>
                        {
                            let _ = window.set_size(LogicalSize::new(
                                cursor_monitor.width,
                                cursor_monitor.height,
                            ));
                        }
                        Ok(_) => {}
                        Err(err) => {
                            warn!(%err, "Failed to read recordings overlay inner size");
                        }
                    }
                }

                #[cfg(target_os = "macos")]
                {
                    app.run_on_main_thread({
                        let window = window.clone();
                        move || {
                            use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
                            use crate::panel_manager::try_to_panel;

                            let panel = match try_to_panel(&window) {
                                Ok(p) => p,
                                Err(e) => {
                                    tracing::error!("Failed to convert recordings overlay to panel: {}", e);
                                    return;
                                }
                            };

                            panel.set_level(cocoa::appkit::NSMainMenuWindowLevel);

                            panel.set_collection_behaviour(
                                NSWindowCollectionBehavior::NSWindowCollectionBehaviorTransient
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorMoveToActiveSpace
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
                            );

                            #[allow(non_upper_case_globals)]
                            const NSWindowStyleMaskNonActivatingPanel: i32 = 1 << 7;
                            panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel);
                        }
                    })
                    .ok();
                }

                fake_window::spawn_fake_window_listener(app.clone(), window.clone());

                window
            }
        };

        // removing this for now as it causes windows to just stay hidden sometimes -_-
        // window.hide().ok();

        #[cfg(target_os = "macos")]
        if let Some(position) = _id.traffic_lights_position() {
            add_traffic_lights(&window, position);
        }

        #[cfg(target_os = "macos")]
        if _id.activates_dock() {
            crate::permissions::sync_macos_dock_visibility(app);
        }

        Ok(window)
    }

    fn window_builder<'a>(
        &'a self,
        app: &'a AppHandle<Wry>,
        url: impl Into<PathBuf>,
    ) -> WebviewWindowBuilder<'a, Wry, AppHandle<Wry>> {
        let id = self.id(app);
        self.window_builder_with_label(app, url, id.label())
    }

    fn window_builder_with_label<'a>(
        &'a self,
        app: &'a AppHandle<Wry>,
        url: impl Into<PathBuf>,
        label: impl Into<String>,
    ) -> WebviewWindowBuilder<'a, Wry, AppHandle<Wry>> {
        let id = self.id(app);

        let settings = GeneralSettingsStore::get(app).ok().flatten();
        let window_transparency_enabled = settings
            .as_ref()
            .map(|s| s.window_transparency)
            .unwrap_or(false);
        let theme = settings
            .map(|s| match s.theme {
                AppTheme::System => None,
                AppTheme::Light => Some(tauri::Theme::Light),
                AppTheme::Dark => Some(tauri::Theme::Dark),
            })
            .unwrap_or(None);

        let mut builder = WebviewWindow::builder(app, label, WebviewUrl::App(url.into()))
            .title(id.title())
            .visible(false)
            .accept_first_mouse(true)
            .shadow(true)
            .theme(theme)
            .devtools(cfg!(debug_assertions));

        if !id.is_transparent() {
            let is_dark = match theme {
                Some(tauri::Theme::Dark) => true,
                Some(tauri::Theme::Light) => false,
                None | Some(_) => is_system_dark_mode(),
            };

            let bg_color = if is_dark { "#141414" } else { "#ffffff" };
            let init_script = format!(
                r#"(function(){{var s=document.createElement('style');s.textContent='html,body{{background-color:{bg_color}}}';document.documentElement.appendChild(s);}})();"#
            );
            builder = builder.initialization_script(&init_script);

            // Native backing color so the window is themed before the webview's
            // first paint, allowing windows to be shown immediately without a
            // white/black flash. Skipped when the user has window transparency
            // enabled: an opaque native background would sit behind the
            // translucent webview content and defeat the effect.
            if !window_transparency_enabled {
                let native_bg = if is_dark {
                    tauri::window::Color(0x14, 0x14, 0x14, 0xff)
                } else {
                    tauri::window::Color(0xff, 0xff, 0xff, 0xff)
                };
                builder = builder.background_color(native_bg);
            }
        }

        if let Some(min) = id.min_size() {
            builder = builder
                .inner_size(min.0, min.1)
                .min_inner_size(min.0, min.1);
        }

        #[cfg(target_os = "macos")]
        {
            if id.traffic_lights_position().is_some() {
                builder = builder
                    .hidden_title(true)
                    .title_bar_style(tauri::TitleBarStyle::Overlay);
            } else {
                builder = builder.decorations(false)
            }
        }

        #[cfg(windows)]
        {
            let browser_args = windows_webview2_browser_args();
            let browser_args_json = serde_json::to_string(&browser_args)
                .expect("Failed to serialize Windows WebView2 browser arguments");
            builder = builder
                .decorations(false)
                .zoom_hotkeys_enabled(false)
                .additional_browser_args(&browser_args)
                .initialization_script(format!(
                    "window.__CAP__ = window.__CAP__ ?? {{}}; window.__CAP__.windowsWebview2BrowserArgs = {browser_args_json};"
                ));
        }

        // Linux has no native macOS-style traffic lights, so we drop the window
        // manager decorations and draw our own chrome (matching the macOS layout).
        #[cfg(target_os = "linux")]
        {
            builder = builder.decorations(false);
        }

        builder
    }

    pub fn id(&self, app: &AppHandle) -> CapWindowId {
        match self {
            ShowCapWindow::Main { .. } => CapWindowId::Main,
            ShowCapWindow::Settings { .. } => CapWindowId::Settings,
            ShowCapWindow::Editor { project_path } => {
                let state = app.state::<EditorWindowIds>();
                let s = state.ids.lock().unwrap();
                let id = s.iter().find(|(path, _)| path == project_path).unwrap().1;
                CapWindowId::Editor { id }
            }
            ShowCapWindow::RecordingsOverlay => CapWindowId::RecordingsOverlay,
            ShowCapWindow::TargetSelectOverlay { display_id, .. } => {
                CapWindowId::TargetSelectOverlay {
                    display_id: display_id.clone(),
                }
            }
            ShowCapWindow::WindowCaptureOccluder { screen_id } => {
                CapWindowId::WindowCaptureOccluder {
                    screen_id: screen_id.clone(),
                }
            }
            ShowCapWindow::CaptureArea { .. } => CapWindowId::CaptureArea,
            ShowCapWindow::Camera { .. } => CapWindowId::Camera,
            ShowCapWindow::InProgressRecording { .. } => CapWindowId::RecordingControls,
            ShowCapWindow::Upgrade => CapWindowId::Upgrade,
            ShowCapWindow::ModeSelect => CapWindowId::ModeSelect,
            ShowCapWindow::Onboarding => CapWindowId::Onboarding,
            ShowCapWindow::ScreenshotEditor { path } => {
                let state = app.state::<ScreenshotEditorWindowIds>();
                let s = state.ids.lock().unwrap();
                let id = s.iter().find(|(p, _)| p == path).unwrap().1;
                CapWindowId::ScreenshotEditor { id }
            }
        }
    }
}

fn lock_window_text_scale(_window: &WebviewWindow<Wry>) {
    #[cfg(windows)]
    {
        let scale_factor = match _window.scale_factor() {
            Ok(scale_factor) => scale_factor,
            Err(e) => {
                warn!("Failed to read window scale factor: {}", e);
                return;
            }
        };

        if let Err(e) = _window.with_webview(move |webview| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3;
            use windows_core::Interface;

            let controller = webview.controller();

            if let Err(e) = controller.SetZoomFactor(1.0) {
                warn!("Failed to lock WebView zoom factor: {}", e);
            }

            let Ok(controller3) = controller.cast::<ICoreWebView2Controller3>() else {
                warn!("Failed to access WebView2 controller scale APIs");
                return;
            };

            if let Err(e) = controller3.SetShouldDetectMonitorScaleChanges(false) {
                warn!("Failed to disable WebView scale detection: {}", e);
            }

            if let Err(e) = controller3.SetRasterizationScale(scale_factor) {
                warn!("Failed to lock WebView rasterization scale: {}", e);
            }
        }) {
            warn!("Failed to access platform WebView: {}", e);
        }
    }
}

/// `lock_window_text_scale` disables WebView2's own monitor-scale detection
/// (so the Windows text-size setting can't zoom the UI), which also stops it
/// following per-monitor DPI. The new scale factor must be forwarded here on
/// every `ScaleFactorChanged`, or a window dragged to a monitor with
/// different scaling keeps rasterizing and laying out at the old DPI.
pub fn update_window_rasterization_scale(_window: &WebviewWindow<Wry>, _scale_factor: f64) {
    #[cfg(windows)]
    {
        if let Err(e) = _window.with_webview(move |webview| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3;
            use windows_core::Interface;

            let controller = webview.controller();

            let Ok(controller3) = controller.cast::<ICoreWebView2Controller3>() else {
                warn!("Failed to access WebView2 controller scale APIs");
                return;
            };

            if let Err(e) = controller3.SetRasterizationScale(_scale_factor) {
                warn!("Failed to update WebView rasterization scale: {}", e);
            }
        }) {
            warn!("Failed to access platform WebView: {}", e);
        }
    }
}

#[cfg(target_os = "macos")]
fn add_traffic_lights(window: &WebviewWindow<Wry>, controls_inset: Option<LogicalPosition<f64>>) {
    use crate::platform::delegates;

    let target_window = window.clone();
    window
        .run_on_main_thread(move || {
            delegates::setup(
                target_window.as_ref().window(),
                controls_inset.unwrap_or(DEFAULT_TRAFFIC_LIGHTS_INSET),
            );

            let c_win = target_window.clone();
            target_window.on_window_event(move |event| match event {
                tauri::WindowEvent::ThemeChanged(..) | tauri::WindowEvent::Focused(..) => {
                    position_traffic_lights_impl(&c_win.as_ref().window(), controls_inset);
                }
                _ => {}
            });
        })
        .ok();
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(window))]
pub fn set_theme(window: tauri::Window, theme: AppTheme) {
    let _ = window.set_theme(match theme {
        AppTheme::System => None,
        AppTheme::Light => Some(tauri::Theme::Light),
        AppTheme::Dark => Some(tauri::Theme::Dark),
    });

    #[cfg(target_os = "macos")]
    match CapWindowId::from_str(window.label()) {
        Ok(win) if win.traffic_lights_position().is_some() => position_traffic_lights(window, None),
        Ok(_) | Err(_) => {}
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(_window))]
pub fn position_traffic_lights(_window: tauri::Window, _controls_inset: Option<(f64, f64)>) {
    #[cfg(target_os = "macos")]
    position_traffic_lights_impl(
        &_window,
        _controls_inset.map(LogicalPosition::from).or_else(|| {
            // Attempt to get the default inset from the window's traffic lights position
            CapWindowId::from_str(_window.label())
                .ok()
                .and_then(|id| id.traffic_lights_position().flatten())
        }),
    );
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(_window))]
pub fn set_teleprompter_window_level(_window: tauri::Window, _always_on_top: bool) {
    #[cfg(target_os = "macos")]
    if _window.label() == CapWindowId::Teleprompter.to_string() {
        let level = if _always_on_top {
            TELEPROMPTER_PANEL_LEVEL
        } else {
            objc2_app_kit::NSNormalWindowLevel
        };
        crate::platform::set_window_level(_window, level);
    }

    #[cfg(not(target_os = "macos"))]
    if _window.label() == CapWindowId::Teleprompter.to_string()
        && let Err(error) = _window.set_always_on_top(_always_on_top)
    {
        warn!(?error, "Failed to update teleprompter window level");
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(_window))]
pub fn set_teleprompter_window_opacity(_window: tauri::Window, _opacity: f64) {
    #[cfg(target_os = "macos")]
    if _window.label() == CapWindowId::Teleprompter.to_string() {
        crate::platform::set_window_opacity(_window, _opacity);
    }
}

#[cfg(target_os = "macos")]
fn position_traffic_lights_impl(
    window: &tauri::Window,
    controls_inset: Option<LogicalPosition<f64>>,
) {
    use crate::platform::delegates::{UnsafeWindowHandle, position_window_controls};
    let c_win = window.clone();
    window
        .run_on_main_thread(move || {
            let ns_window = match c_win.ns_window() {
                Ok(handle) => handle,
                Err(_) => return,
            };
            position_window_controls(
                UnsafeWindowHandle(ns_window),
                &controls_inset.unwrap_or(DEFAULT_TRAFFIC_LIGHTS_INSET),
            );
        })
        .ok();
}

// Capture exclusion (WDA_EXCLUDEFROMCAPTURE / NSWindowSharingType::None) also hides
// the window from "capture-based" displays such as virtual/indirect/dummy-HDMI or
// mirrored monitors, making it invisible and unreachable. We therefore only protect
// Cap's own windows while a recording is actually active, which is the only time the
// exclusion is meaningful.
//
// On desktops that are themselves delivered through a capture-based stream (Shadow
// and other cloud PCs, RDP, VMs), even recording-gated exclusion hides the recording
// controls from the user and trips DRM detectors (Shadow error S:102), so exclusion
// is skipped entirely there — Cap's windows then appear in recordings, which is the
// lesser evil. Overridable via the CAP_WINDOW_CAPTURE_EXCLUSION env var.
#[cfg(target_os = "windows")]
pub fn capture_exclusion_hides_ui() -> bool {
    static LAST_LOGGED: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

    let reason = crate::platform::win::capture_streamed_display_reason();

    if let Ok(mut last) = LAST_LOGGED.lock()
        && *last != reason
    {
        match &reason {
            Some(reason) => warn!(
                %reason,
                "Skipping window capture exclusion: this desktop is viewed through a \
                 capture-based stream, so excluded windows would be invisible to the user. \
                 Cap's windows will appear in recordings."
            ),
            None => info!("Window capture exclusion re-enabled"),
        }
        *last = reason.clone();
    }

    reason.is_some()
}

#[cfg(not(target_os = "windows"))]
pub fn capture_exclusion_hides_ui() -> bool {
    false
}

fn content_protection_enabled(app: &AppHandle<Wry>) -> bool {
    app.try_state::<ArcLock<crate::App>>()
        .and_then(|state| {
            state
                .try_read()
                .ok()
                .map(|app| app.is_recording_active_or_pending())
        })
        .unwrap_or(false)
}

fn window_capture_excluded(app: &AppHandle<Wry>, window_title: &str) -> bool {
    if window_title == CapWindowId::Teleprompter.title() {
        return true;
    }

    let matches = |list: &[WindowExclusion]| {
        list.iter()
            .any(|entry| entry.matches(None, None, Some(window_title)))
    };

    GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .map(|settings| matches(&settings.excluded_windows))
        .unwrap_or_else(|| matches(&general_settings::default_excluded_windows()))
}

fn should_protect_window(app: &AppHandle<Wry>, window_title: &str) -> bool {
    content_protection_enabled(app)
        && !capture_exclusion_hides_ui()
        && window_capture_excluded(app, window_title)
}

pub fn apply_content_protection(app: &AppHandle<Wry>, enabled: bool) {
    let enabled = enabled && !capture_exclusion_hides_ui();

    for (label, window) in app.webview_windows() {
        let Ok(id) = CapWindowId::from_str(&label) else {
            continue;
        };

        // The camera window's protection depends on the recording mode (studio excludes
        // the preview, instant keeps it) and is driven from `start_recording`. Only ever
        // clear it here so it stays visible outside of recordings.
        if matches!(id, CapWindowId::Camera) {
            if !enabled {
                let _ = window.set_content_protected(false);
            }
            continue;
        }

        let title = id.title();
        let should_protect = enabled && window_capture_excluded(app, &title);
        let _ = window.set_content_protected(should_protect);

        #[cfg(target_os = "windows")]
        log_window_content_protection(&window, should_protect, &title);
    }
}

#[cfg(target_os = "windows")]
fn cached_windows_version() -> Option<&'static scap_direct3d::WindowsVersion> {
    static VERSION: std::sync::OnceLock<Option<scap_direct3d::WindowsVersion>> =
        std::sync::OnceLock::new();
    VERSION
        .get_or_init(scap_direct3d::WindowsVersion::detect)
        .as_ref()
}

#[cfg(target_os = "windows")]
fn display_affinity_name(value: u32) -> &'static str {
    match value {
        0 => "WDA_NONE",
        1 => "WDA_MONITOR",
        17 => "WDA_EXCLUDEFROMCAPTURE",
        _ => "UNKNOWN",
    }
}

#[cfg(target_os = "windows")]
fn log_window_content_protection(window: &WebviewWindow, enabled: bool, window_title: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };

    let expected = if enabled {
        WDA_EXCLUDEFROMCAPTURE
    } else {
        WDA_NONE
    };

    if let Some(version) = cached_windows_version()
        && enabled
        && version.build < 19041
    {
        warn!(
            window = window.label(),
            title = window_title,
            version = %version.display_name(),
            expected = display_affinity_name(expected.0),
            "Window capture exclusion is not fully supported on this Windows build"
        );
    }

    let hwnd = match window.hwnd() {
        Ok(hwnd) => windows::Win32::Foundation::HWND(hwnd.0),
        Err(error) => {
            warn!(
                window = window.label(),
                title = window_title,
                error = %error,
                "Failed to get HWND for content protection diagnostics"
            );
            return;
        }
    };

    let mut applied = 0u32;
    match unsafe { GetWindowDisplayAffinity(hwnd, &mut applied) } {
        Ok(()) => {
            if applied == expected.0 {
                debug!(
                    window = window.label(),
                    title = window_title,
                    expected = display_affinity_name(expected.0),
                    applied = display_affinity_name(applied),
                    "Window content protection verified"
                );
            } else {
                warn!(
                    window = window.label(),
                    title = window_title,
                    expected = display_affinity_name(expected.0),
                    expected_raw = expected.0,
                    applied = display_affinity_name(applied),
                    applied_raw = applied,
                    "Window content protection mismatch"
                );
            }
        }
        Err(error) => {
            warn!(
                window = window.label(),
                title = window_title,
                expected = display_affinity_name(expected.0),
                error = %error,
                "Failed to query window display affinity"
            );
        }
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub fn refresh_window_content_protection(app: AppHandle<Wry>) -> Result<(), String> {
    let enabled = content_protection_enabled(&app);
    apply_content_protection(&app, enabled);
    Ok(())
}

// Credits: tauri-plugin-window-state
trait MonitorExt {
    fn intersects(
        &self,
        position: PhysicalPosition<i32>,
        size: PhysicalSize<u32>,
        scale: f64,
    ) -> bool;
}

impl MonitorExt for Display {
    fn intersects(
        &self,
        position: PhysicalPosition<i32>,
        size: PhysicalSize<u32>,
        _scale: f64,
    ) -> bool {
        #[cfg(target_os = "macos")]
        {
            let Some(bounds) = self.raw_handle().logical_bounds() else {
                return false;
            };

            let left = (bounds.position().x() * _scale) as i32;
            let right = left + (bounds.size().width() * _scale) as i32;
            let top = (bounds.position().y() * _scale) as i32;
            let bottom = top + (bounds.size().height() * _scale) as i32;

            [
                (position.x, position.y),
                (position.x + size.width as i32, position.y),
                (position.x, position.y + size.height as i32),
                (
                    position.x + size.width as i32,
                    position.y + size.height as i32,
                ),
            ]
            .into_iter()
            .any(|(x, y)| x >= left && x < right && y >= top && y < bottom)
        }

        #[cfg(windows)]
        {
            let Some(bounds) = self.raw_handle().physical_bounds() else {
                return false;
            };

            let left = bounds.position().x() as i32;
            let right = left + bounds.size().width() as i32;
            let top = bounds.position().y() as i32;
            let bottom = top + bounds.size().height() as i32;

            [
                (position.x, position.y),
                (position.x + size.width as i32, position.y),
                (position.x, position.y + size.height as i32),
                (
                    position.x + size.width as i32,
                    position.y + size.height as i32,
                ),
            ]
            .into_iter()
            .any(|(x, y)| x >= left && x < right && y >= top && y < bottom)
        }

        #[cfg(target_os = "linux")]
        {
            let Some(bounds) = self.raw_handle().physical_bounds() else {
                return false;
            };

            let left = bounds.position().x() as i32;
            let right = left + bounds.size().width() as i32;
            let top = bounds.position().y() as i32;
            let bottom = top + bounds.size().height() as i32;

            [
                (position.x, position.y),
                (position.x + size.width as i32, position.y),
                (position.x, position.y + size.height as i32),
                (
                    position.x + size.width as i32,
                    position.y + size.height as i32,
                ),
            ]
            .into_iter()
            .any(|(x, y)| x >= left && x < right && y >= top && y < bottom)
        }
    }
}

#[specta::specta]
#[tauri::command(async)]
#[instrument(skip(_window))]
pub async fn apply_macos_liquid_glass_background(
    _window: tauri::Window,
    _enabled: bool,
    _radius: f64,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let window = _window.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();

        _window
            .run_on_main_thread(move || {
                let result = if window.label() == CapWindowId::Main.label() {
                    crate::platform::apply_main_window_liquid_glass_background(
                        &window, _enabled, _radius,
                    )
                } else {
                    crate::platform::apply_liquid_glass_background(&window, _enabled, _radius)
                };
                let _ = tx.send(result);
            })
            .map_err(|error| error.to_string())?;

        return rx
            .await
            .map_err(|_| "macOS Liquid Glass task was cancelled".to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

#[specta::specta]
#[tauri::command(async)]
#[instrument(skip(_window))]
pub fn set_window_transparent(_window: tauri::Window, _value: bool) {
    #[cfg(target_os = "macos")]
    {
        let ns_win = _window
            .ns_window()
            .expect("Failed to get native window handle")
            as *const objc2_app_kit::NSWindow;

        unsafe {
            (*ns_win).setOpaque(!_value);
        }
    }
}

#[derive(Default, Clone)]
pub struct EditorWindowIds {
    pub ids: Arc<Mutex<Vec<(PathBuf, u32)>>>,
    pub counter: Arc<AtomicU32>,
}

impl EditorWindowIds {
    pub fn get(app: &AppHandle) -> Self {
        app.state::<EditorWindowIds>().deref().clone()
    }
}

#[derive(Default, Clone)]
pub struct ScreenshotEditorWindowIds {
    pub ids: Arc<Mutex<Vec<(PathBuf, u32)>>>,
    pub counter: Arc<AtomicU32>,
}

impl ScreenshotEditorWindowIds {
    pub fn get(app: &AppHandle) -> Self {
        app.state::<ScreenshotEditorWindowIds>().deref().clone()
    }
}

#[derive(Default, Clone)]
pub struct EditorRecordingTarget(pub Arc<Mutex<Option<PathBuf>>>);

impl EditorRecordingTarget {
    pub fn get(app: &AppHandle) -> Self {
        app.state::<EditorRecordingTarget>().deref().clone()
    }

    pub fn set(app: &AppHandle, path: Option<PathBuf>) {
        *Self::get(app).0.lock().unwrap() = path;
    }

    pub fn current(app: &AppHandle) -> Option<PathBuf> {
        Self::get(app).0.lock().unwrap().clone()
    }

    pub fn take(app: &AppHandle) -> Option<PathBuf> {
        Self::get(app).0.lock().unwrap().take()
    }
}

pub fn editor_window_for_path(app: &AppHandle, path: &std::path::Path) -> Option<WebviewWindow> {
    let ids = EditorWindowIds::get(app);
    let id = {
        let guard = ids.ids.lock().unwrap();
        guard.iter().find(|(p, _)| p == path).map(|(_, id)| *id)?
    };
    CapWindowId::Editor { id }.get(app)
}
