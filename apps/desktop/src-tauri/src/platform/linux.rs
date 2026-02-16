use tauri::Window;

pub fn set_window_level(_window: &Window, _level: i32) {}

pub fn set_above_all_windows(_window: &Window) {
    _window.set_always_on_top(true).ok();
}
