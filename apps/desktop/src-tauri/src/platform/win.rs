use std::ffi::c_void;
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{
        BringWindowToTop, HWND_NOTOPMOST, HWND_TOP, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SetWindowPos,
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
                // First make it topmost
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                // Then bring it to the very top of topmost windows
                let _ = BringWindowToTop(hwnd);
                // Additional call to ensure it's at the front
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOP),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
            // TargetSelectOverlay - should be below NewMain
            45 => {
                // Make it topmost but don't bring to front
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                // Don't call BringWindowToTop for this level - let NewMain stay on top
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

/// Additional function to ensure NewMain window stays on top
/// This can be called from the Tauri application when needed
pub fn ensure_window_on_top(window: tauri::Window) {
    let c_window = window.clone();
    let _ = window.run_on_main_thread(move || unsafe {
        let raw_handle = c_window.hwnd().expect("Failed to get native window handle");
        let hwnd = HWND(raw_handle.0 as *mut c_void);

        // Bring to top of topmost windows
        let _ = BringWindowToTop(hwnd);
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    });
}
