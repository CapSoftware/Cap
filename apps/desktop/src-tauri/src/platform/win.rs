use std::ffi::c_void;
use std::sync::{Arc, Mutex, OnceLock};
use std::collections::HashMap;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM, HHOOK},
    UI::WindowsAndMessaging::{
        BringWindowToTop, HWND_NOTOPMOST, HWND_TOP, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SetForegroundWindow, SetWindowPos, SetWindowLongPtrW, GetWindowLongPtrW,
        GWLP_HWNDPARENT, WM_ACTIVATE, WA_ACTIVE, WA_CLICKACTIVE, DefWindowProcW,
        SetWindowsHookExW, UnhookWindowsHookEx, CallNextHookEx, WH_CBT, HCBT_ACTIVATE,
        WH_SHELL, HSHELL_WINDOWACTIVATED, GetCurrentThreadId,
    },
};
use tauri::AppHandle;

// Global state for window relationship management
static WINDOW_STATE: OnceLock<Arc<Mutex<WindowState>>> = OnceLock::new();

fn get_window_state() -> &'static Arc<Mutex<WindowState>> {
    WINDOW_STATE.get_or_init(|| Arc::new(Mutex::new(WindowState::new())))
}

struct WindowState {
    overlay_windows: HashMap<String, HWND>,
    main_windows: HashMap<String, HWND>,
    overlay_active: bool,
    hook_handle: Option<HHOOK>,
}

impl WindowState {
    fn new() -> Self {
        Self {
            overlay_windows: HashMap::new(),
            main_windows: HashMap::new(),
            overlay_active: false,
            hook_handle: None,
        }
    }
}

/// Sets the window level (z-order) on Windows with improved layering
///
/// Enhanced approach:
/// - Uses owner/owned window relationships for proper Z-order
/// - Temporarily promotes NewMain to TOPMOST when overlay is active
/// - Monitors window activation to maintain proper layering
/// - Falls back to standard behavior for system-critical windows
///
/// Level mapping:
/// - 1000+ -> HWND_TOPMOST (highest priority - InProgressRecording, etc.)
/// - 900 -> HWND_TOPMOST (WindowCaptureOccluder)
/// - 50 -> Smart layering (NewMain window - TOPMOST when overlay active, TOP otherwise)
/// - 45 -> Owned window (TargetSelectOverlay - owned by NewMain for proper layering)
/// - Default -> HWND_NOTOPMOST
pub fn set_window_level(window: tauri::Window, level: i32) {
    let window_label = window.label().to_string();
    let c_window = window.clone();
    
    _ = window.run_on_main_thread(move || unsafe {
        let raw_handle = c_window.hwnd().expect("Failed to get native window handle");
        let hwnd = HWND(raw_handle.0 as *mut c_void);

        // Update window state tracking
        {
            let mut state = get_window_state().lock().unwrap();
            match level {
                50 => {
                    state.main_windows.insert(window_label.clone(), hwnd);
                    // Install hook if this is the first main window and we don't have one yet
                    if state.hook_handle.is_none() {
                        install_window_hook();
                    }
                }
                45 => {
                    state.overlay_windows.insert(window_label.clone(), hwnd);
                    state.overlay_active = true;
                }
                _ => {}
            }
        }

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
            // NewMain window - smart layering based on overlay state
            50 => {
                set_main_window_level(hwnd, &window_label);
            }
            // TargetSelectOverlay - set up owner relationship with main window
            45 => {
                set_overlay_window_level(hwnd, &window_label);
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

/// Sets up the main window with smart layering based on overlay state
unsafe fn set_main_window_level(hwnd: HWND, window_label: &str) {
    let overlay_active = {
        let state = get_window_state().lock().unwrap();
        state.overlay_active && !state.overlay_windows.is_empty()
    };

    if overlay_active {
        // When overlay is active, temporarily promote to TOPMOST to ensure visibility
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        
        // Then immediately demote to TOP to allow normal window interaction
        // but maintain position above overlay
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
    } else {
        // Normal behavior when no overlay is active
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
    }

    // Always ensure the window can receive focus
    let _ = BringWindowToTop(hwnd);
    let _ = SetForegroundWindow(hwnd);
}

/// Sets up the overlay window with proper owner relationship
unsafe fn set_overlay_window_level(hwnd: HWND, window_label: &str) {
    // Find the main window to establish owner relationship
    let main_hwnd = {
        let state = get_window_state().lock().unwrap();
        state.main_windows.values().next().copied()
    };

    // Set up owner relationship if main window exists
    if let Some(owner_hwnd) = main_hwnd {
        // Set the main window as the owner of this overlay
        // This ensures proper Z-order behavior
        let _ = SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner_hwnd.0 as isize);
    }

    // Set overlay as regular window (not topmost)
    let _ = SetWindowPos(
        hwnd,
        Some(HWND_NOTOPMOST),
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
    );

    // After setting up overlay, ensure main windows stay on top
    refresh_main_window_positions();
}

/// Refreshes the position of all main windows to ensure they stay above overlays
unsafe fn refresh_main_window_positions() {
    let main_windows = {
        let state = get_window_state().lock().unwrap();
        state.main_windows.values().copied().collect::<Vec<_>>()
    };

    for hwnd in main_windows {
        set_main_window_level(hwnd, ""); // Empty label since we're working directly with HWND
    }
}

/// Ensures the NewMain window stays on top of overlay windows
/// This should be called whenever an overlay becomes visible or the main window needs focus
pub fn ensure_window_on_top(window: tauri::Window) {
    let window_label = window.label().to_string();
    let c_window = window.clone();
    let _ = window.run_on_main_thread(move || unsafe {
        let raw_handle = c_window.hwnd().expect("Failed to get native window handle");
        let hwnd = HWND(raw_handle.0 as *mut c_void);

        set_main_window_level(hwnd, &window_label);
    });
}

/// Window hook procedure to monitor window activation events
unsafe extern "system" fn window_hook_proc(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code >= 0 {
        match code as u32 {
            HSHELL_WINDOWACTIVATED => {
                // A window was activated - check if it's an overlay and respond accordingly
                let activated_hwnd = HWND(wparam.0 as *mut c_void);
                handle_window_activation(activated_hwnd);
            }
            _ => {}
        }
    }
    
    CallNextHookEx(None, code, wparam, lparam)
}

/// Handles window activation events to maintain proper Z-order
unsafe fn handle_window_activation(activated_hwnd: HWND) {
    let state = get_window_state().lock().unwrap();
    
    // Check if an overlay window was activated
    let overlay_activated = state.overlay_windows.values().any(|&hwnd| hwnd == activated_hwnd);
    
    if overlay_activated {
        // An overlay was activated - bring all main windows to top
        let main_windows: Vec<HWND> = state.main_windows.values().copied().collect();
        drop(state); // Release lock before making Windows API calls
        
        for main_hwnd in main_windows {
            set_main_window_level(main_hwnd, "");
        }
    }
}

/// Installs a window hook to monitor activation events
fn install_window_hook() {
    unsafe {
        let hook = SetWindowsHookExW(
            WH_SHELL,
            Some(window_hook_proc),
            None,
            GetCurrentThreadId(),
        );
        
        if let Ok(hook_handle) = hook {
            let mut state = get_window_state().lock().unwrap();
            state.hook_handle = Some(hook_handle);
        }
    }
}

/// Removes the window hook when no longer needed
fn remove_window_hook() {
    let mut state = get_window_state().lock().unwrap();
    if let Some(hook_handle) = state.hook_handle.take() {
        unsafe {
            let _ = UnhookWindowsHookEx(hook_handle);
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

/// Tauri command to refresh window layering - useful for debugging
#[tauri::command]
#[specta::specta]
#[cfg(target_os = "windows")]
pub fn refresh_window_layering(app: tauri::AppHandle) -> Result<(), String> {
    unsafe {
        refresh_main_window_positions();
    }
    Ok(())
}

/// Marks an overlay as closed and updates the global state
#[cfg(target_os = "windows")]
pub fn mark_overlay_closed(window_label: &str) {
    let mut state = get_window_state().lock().unwrap();
    state.overlay_windows.remove(window_label);
    
    // If no overlays remain, mark overlay as inactive
    if state.overlay_windows.is_empty() {
        state.overlay_active = false;
        
        // Refresh main window positions to normal state
        let main_windows: Vec<HWND> = state.main_windows.values().copied().collect();
        drop(state);
        
        unsafe {
            for hwnd in main_windows {
                set_main_window_level(hwnd, "");
            }
        }
    }
}

/// Marks a main window as closed and cleans up state
#[cfg(target_os = "windows")]
pub fn mark_main_window_closed(window_label: &str) {
    let mut state = get_window_state().lock().unwrap();
    state.main_windows.remove(window_label);
    
    // If no main windows remain, remove the hook
    if state.main_windows.is_empty() && state.hook_handle.is_some() {
        if let Some(hook_handle) = state.hook_handle.take() {
            unsafe {
                let _ = UnhookWindowsHookEx(hook_handle);
            }
        }
    }
}

/// Helper function to handle window activation events for proper Z-order management
/// This should be called when the main window receives WM_ACTIVATE or similar events
pub fn handle_main_window_activation(window: tauri::Window) {
    // When the main window is activated, ensure it stays on top of any overlays
    ensure_window_on_top(window);
}
