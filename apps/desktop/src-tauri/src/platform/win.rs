use std::ffi::c_void;
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{
        BringWindowToTop, HWND_NOTOPMOST, HWND_TOP, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SetForegroundWindow, SetWindowPos,
    },
};

/// Sets the window level (z-order) on Windows following recommended practices
///
/// Approach:
/// - Overlay windows (like TargetSelectOverlay) are created as regular windows (not TOPMOST)
/// - Main application windows are brought to HWND_TOP when overlay is shown
/// - Only truly system-critical windows use HWND_TOPMOST
///
/// Level mapping:
/// - 1000+ -> HWND_TOPMOST (highest priority - InProgressRecording, etc.)
/// - 900 -> HWND_TOPMOST (WindowCaptureOccluder)
/// - 50 -> HWND_TOP (NewMain window - should be above overlays)
/// - 45 -> Regular window (TargetSelectOverlay - covers screen but allows main app on top)
/// - Default -> HWND_NOTOPMOST
pub fn set_window_level(window: tauri::Window, level: i32) {
    let c_window = window.clone();
    _ = window.run_on_main_thread(move || unsafe {
        let raw_handle = c_window.hwnd().expect("Failed to get native window handle");
        let hwnd = HWND(raw_handle.0 as *mut c_void);

        match level {
            // High priority windows - always on top (system critical)
            1000.. => {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
            // WindowCaptureOccluder - needs to be truly topmost
            900 => {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
            // NewMain window - should be at top of regular Z-order, above overlays
            50 => {
                // First remove any TOPMOST status to ensure proper Z-order management
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_NOTOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );

                // Then bring to top of non-topmost windows
                let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);

                // Bring to foreground so user can interact with it
                let _ = BringWindowToTop(hwnd);
                let _ = SetForegroundWindow(hwnd);
            }
            // TargetSelectOverlay - regular window that covers screen
            // This allows the main app to be brought above it with HWND_TOP
            45 => {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_NOTOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
            // Default case - regular window
            _ => {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_NOTOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
    });
}

/// Ensures the NewMain window stays on top of overlay windows
/// This should be called whenever an overlay becomes visible or the main window needs focus
pub fn ensure_window_on_top(window: tauri::Window) {
    let c_window = window.clone();
    let _ = window.run_on_main_thread(move || unsafe {
        let raw_handle = c_window.hwnd().expect("Failed to get native window handle");
        let hwnd = HWND(raw_handle.0 as *mut c_void);

        // Use the same logic as level 50 to bring window to top
        set_window_level_internal(hwnd, 50);
    });
}

/// Internal helper that directly operates on HWND
/// This avoids the overhead of thread dispatching when we're already on the main thread
unsafe fn set_window_level_internal(hwnd: HWND, level: i32) {
    match level {
        50 => {
            // NewMain window - bring to top of regular Z-order
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_NOTOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );

                let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);

                let _ = BringWindowToTop(hwnd);
                let _ = SetForegroundWindow(hwnd);
            }
        }
        45 => {
            // TargetSelectOverlay - ensure it's not topmost
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_NOTOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
        }
        _ => {
            // For other levels, defer to the main function
            // This is a bit recursive but avoids code duplication
        }
    }
}

/// Tauri command to manually force the main window to the top
/// This can be called from the frontend when the user clicks on the main window
/// or when focus management is needed
#[tauri::command]
#[specta::specta]
pub fn force_main_window_to_top(app: tauri::AppHandle) -> Result<(), String> {
    use crate::windows::CapWindowId;

    if let Some(main_window) = CapWindowId::NewMain.get(&app) {
        ensure_window_on_top(main_window.as_ref().window().clone());
        Ok(())
    } else {
        Err("NewMain window not found".to_string())
    }
}

/// Helper function to handle window activation events for proper Z-order management
/// This should be called when the main window receives WM_ACTIVATE or similar events
pub fn handle_main_window_activation(window: tauri::Window) {
    // When the main window is activated, ensure it stays on top of any overlays
    ensure_window_on_top(window);
}
