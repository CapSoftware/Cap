use crate::platform::{Bounds, Window};
use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
};

unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
    let windows = &mut *(lparam.0 as *mut Vec<Window>);
    1
}

pub fn get_on_screen_windows() -> Vec<Window> {
    vec![]
}

pub fn bring_window_to_focus(window_id: u32) {
    // TODO!
    println!("Bring {window_id} to focus")
}
