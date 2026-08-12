mod sc_shareable_content;

pub use sc_shareable_content::*;

pub fn constrain_main_window_to_visible_top(
    _window: &cap_desktop_runtime::Window,
    _position: cap_desktop_runtime::PhysicalPosition<i32>,
) -> Option<cap_desktop_runtime::PhysicalPosition<i32>> {
    None
}

pub fn teardown_all_liquid_glass_on_main(app: &cap_desktop_runtime::AppHandle) -> usize {
    let count = app.webview_windows().len();
    let _ = app.native_operation("window.teardownVisualEffects", serde_json::json!({}));
    count
}

pub async fn teardown_all_liquid_glass(app: &cap_desktop_runtime::AppHandle) -> Result<(), String> {
    app.native_operation("window.teardownVisualEffects", serde_json::json!({}))
}
