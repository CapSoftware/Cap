use std::ffi::c_void;
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{
        BringWindowToTop, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SetForegroundWindow, SetWindowPos,
    },
};

/// Sets the window level (z-order) on Windows
/// Level mapping:
/// - 1000+ -> HWND_TOPMOST (highest priority - InProgressRecording, etc.)
/// - 900 -> HWND_TOPMOST (WindowCaptureOccluder)
/// - 50 -> HWND_TOPMOST (NewMain window - should be above TargetSelectOverlay)
/// - 45 -> HWND_TOPMOST but positioned below level 50 windows (TargetSelectOverlay)
/// - Default -> HWND_NOTOPMOST
pub fn set_window_level(window: tauri::Window, level: i32) {
    let c_window = window.clone();
    _ = window.run_on_main_thread(move || unsafe {
        let raw_handle = c_window.hwnd().expect("Failed to get native window handle");
        let hwnd = HWND(raw_handle.0 as *mut c_void);

        match level {
            // High priority windows - always on top
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
            // WindowCaptureOccluder
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
            // NewMain window - must be above TargetSelectOverlay
            50 => {
                // Simple but reliable approach: set as topmost and bring to front
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE,
                );

                // Bring to the front of topmost windows
                let _ = BringWindowToTop(hwnd);
                let _ = SetForegroundWindow(hwnd);
            }
            // TargetSelectOverlay - should be below NewMain
            45 => {
                // Set as topmost but don't bring to front - let it stay behind level 50 windows
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
            // Default case - not topmost
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

/// Simplified function to ensure NewMain window stays on top
pub fn ensure_window_on_top(window: tauri::Window) {
    let c_window = window.clone();
    let _ = window.run_on_main_thread(move || {
        let raw_handle = c_window.hwnd().expect("Failed to get native window handle");
        let hwnd = HWND(raw_handle.0 as *mut c_void);

        // Simplified approach - just set level 50 again
        set_window_level_internal(hwnd, 50);
    });
}

/// Internal helper that directly operates on HWND
unsafe fn set_window_level_internal(hwnd: HWND, level: i32) {
    match level {
        50 => {
            // NewMain window - simplified approach
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE,
                );
                let _ = BringWindowToTop(hwnd);
                let _ = SetForegroundWindow(hwnd);
            }
        }
        _ => {
            // For other levels, use the original logic
        }
    }
}

/// Simplified positioning function
pub fn position_window_above_target(main_window: tauri::Window, _target_window: tauri::Window) {
    // Just call ensure_window_on_top for simplicity
    ensure_window_on_top(main_window);
}

/// Check if a window handle is valid - utility function
pub fn is_window_valid(window: &tauri::Window) -> bool {
    window.hwnd().is_ok()
}

/// Tauri command to manually force the main window to the top
/// This can be called from the frontend when needed
#[tauri::command]
pub fn force_main_window_to_top(app: tauri::AppHandle) -> Result<(), String> {
    use crate::windows::CapWindowId;

    if let Some(main_window) = CapWindowId::NewMain.get(&app) {
        set_window_level(main_window.as_ref().window().clone(), 50);
        Ok(())
    } else {
        Err("NewMain window not found".to_string())
    }
}
