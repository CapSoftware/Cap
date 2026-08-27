use std::ffi::c_void;
use std::path::{Path, PathBuf};

use gpui::{ForegroundExecutor, Window, WindowAppearance};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DefWindowProcW, GetForegroundWindow, GetWindowDisplayAffinity, GetWindowRect, HWND_NOTOPMOST,
    HWND_TOP, HWND_TOPMOST, IsIconic, IsWindowVisible, IsZoomed, PostMessageW, SW_HIDE,
    SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, SW_SHOW, SW_SHOWNOACTIVATE, SWP_ASYNCWINDOWPOS,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SetForegroundWindow,
    SetWindowDisplayAffinity, SetWindowPos, ShowWindowAsync, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    WM_CLOSE, WM_NCACTIVATE,
};

use super::{ForcedAppearance, MaterialKind, PanelBehavior};

mod capture_exclusion;

#[derive(Clone, Copy)]
pub struct NativeWindow(isize);

impl NativeWindow {
    fn hwnd(self) -> HWND {
        self.0 as HWND
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Rect {
    fn is_valid(self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && self.width > 0.
            && self.height > 0.
    }
}

#[derive(Clone, Copy, Debug)]
struct DisplayGeometry {
    physical: Rect,
    logical: Rect,
}

fn native_handle(window: &Window) -> Option<isize> {
    let handle = HasWindowHandle::window_handle(window).ok()?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return None;
    };
    Some(handle.hwnd.get())
}

pub fn native_window(window: &Window) -> Option<NativeWindow> {
    native_handle(window).map(NativeWindow)
}

#[link(name = "dwmapi")]
unsafe extern "system" {
    fn DwmSetWindowAttribute(hwnd: HWND, attribute: u32, value: *const c_void, size: u32) -> i32;
}

pub fn apply_window_theme(
    window: &Window,
    appearance: ForcedAppearance,
    executor: &ForegroundExecutor,
) {
    const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
    let Some(native) = native_window(window) else {
        return;
    };
    let dark = i32::from(match appearance {
        ForcedAppearance::System => matches!(
            window.appearance(),
            WindowAppearance::Dark | WindowAppearance::VibrantDark
        ),
        ForcedAppearance::Light => false,
        ForcedAppearance::Dark => true,
    });
    executor
        .spawn(async move {
            let result = unsafe {
                DwmSetWindowAttribute(
                    native.hwnd(),
                    DWMWA_USE_IMMERSIVE_DARK_MODE,
                    std::ptr::addr_of!(dark).cast(),
                    std::mem::size_of_val(&dark) as u32,
                )
            };
            if result < 0 {
                tracing::debug!(result, "native window theme is not supported");
                return;
            }
            unsafe {
                // As in Tao, redraw the nonclient colors without changing OS focus.
                let active = GetForegroundWindow() == native.hwnd();
                DefWindowProcW(native.hwnd(), WM_NCACTIVATE, usize::from(!active), 0);
                DefWindowProcW(native.hwnd(), WM_NCACTIVATE, usize::from(active), 0);
            }
        })
        .detach();
}

pub fn window_is_dark(_window: &Window) -> Option<bool> {
    None
}

pub fn debug_titlebar_state(_window: &Window) -> Option<String> {
    None
}

pub fn install_window_material(_native: &NativeWindow, _radius: f64) -> Option<MaterialKind> {
    None
}

pub fn recording_controls_level() -> isize {
    1
}

pub fn target_overlay_level() -> isize {
    1
}

pub fn teleprompter_level() -> isize {
    1
}

pub fn set_window_alpha(_native: &NativeWindow, _alpha: f64) -> f64 {
    1.
}

pub fn set_window_capture_hidden(native: &NativeWindow, hidden: bool) -> usize {
    let streamed = hidden
        .then(capture_exclusion::streamed_display_reason)
        .flatten();
    if let Some(reason) = &streamed {
        tracing::debug!(%reason, "keeping window visible on streamed desktop");
    }
    let affinity = if hidden && streamed.is_none() {
        WDA_EXCLUDEFROMCAPTURE
    } else {
        WDA_NONE
    };
    unsafe {
        if SetWindowDisplayAffinity(native.hwnd(), affinity) == 0 {
            return 0;
        }
        let mut current = WDA_NONE;
        if GetWindowDisplayAffinity(native.hwnd(), &mut current) == 0 {
            return affinity as usize;
        }
        current as usize
    }
}

pub fn restore_borderless_style(_native: &NativeWindow) {}

pub fn remove_popup_window_chrome(_native: &NativeWindow) {}

fn to_rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

fn display_geometries() -> Vec<DisplayGeometry> {
    scap_targets::Display::list()
        .into_iter()
        .filter_map(|display| {
            let physical = display.raw_handle().physical_bounds()?;
            let logical = display.raw_handle().logical_bounds()?;
            let geometry = DisplayGeometry {
                physical: to_rect(
                    physical.position().x(),
                    physical.position().y(),
                    physical.size().width(),
                    physical.size().height(),
                ),
                logical: to_rect(
                    logical.position().x(),
                    logical.position().y(),
                    logical.size().width(),
                    logical.size().height(),
                ),
            };
            (geometry.physical.is_valid() && geometry.logical.is_valid()).then_some(geometry)
        })
        .collect()
}

fn intersection_area(first: Rect, second: Rect) -> f64 {
    if !first.is_valid() || !second.is_valid() {
        return 0.;
    }
    let width = (first.x + first.width).min(second.x + second.width) - first.x.max(second.x);
    let height = (first.y + first.height).min(second.y + second.height) - first.y.max(second.y);
    if width > 0. && height > 0. {
        width * height
    } else {
        0.
    }
}

fn center_distance_squared(first: Rect, second: Rect) -> f64 {
    let dx = first.x + first.width / 2. - (second.x + second.width / 2.);
    let dy = first.y + first.height / 2. - (second.y + second.height / 2.);
    dx.mul_add(dx, dy * dy)
}

fn select_physical_display(rect: Rect, displays: &[DisplayGeometry]) -> Option<DisplayGeometry> {
    displays
        .iter()
        .max_by(|first, second| {
            intersection_area(rect, first.physical)
                .total_cmp(&intersection_area(rect, second.physical))
                .then_with(|| {
                    center_distance_squared(rect, second.physical)
                        .total_cmp(&center_distance_squared(rect, first.physical))
                })
        })
        .copied()
}

fn select_logical_display(
    rect: Rect,
    displays: &[DisplayGeometry],
    exact: bool,
) -> Option<DisplayGeometry> {
    if exact
        && let Some(display) = displays.iter().find(|display| {
            let bounds = display.logical;
            (rect.x - bounds.x).abs() <= 1.
                && (rect.y - bounds.y).abs() <= 1.
                && (rect.width - bounds.width).abs() <= 1.
                && (rect.height - bounds.height).abs() <= 1.
        })
    {
        return Some(*display);
    }
    displays
        .iter()
        .max_by(|first, second| {
            intersection_area(rect, first.logical)
                .total_cmp(&intersection_area(rect, second.logical))
                .then_with(|| {
                    center_distance_squared(rect, second.logical)
                        .total_cmp(&center_distance_squared(rect, first.logical))
                })
        })
        .copied()
}

fn physical_to_logical(rect: Rect, display: DisplayGeometry) -> Rect {
    let scale_x = display.logical.width / display.physical.width;
    let scale_y = display.logical.height / display.physical.height;
    Rect {
        x: display.logical.x + (rect.x - display.physical.x) * scale_x,
        y: display.logical.y + (rect.y - display.physical.y) * scale_y,
        width: rect.width * scale_x,
        height: rect.height * scale_y,
    }
}

fn logical_to_physical(rect: Rect, display: DisplayGeometry) -> Rect {
    let scale_x = display.physical.width / display.logical.width;
    let scale_y = display.physical.height / display.logical.height;
    Rect {
        x: display.physical.x + (rect.x - display.logical.x) * scale_x,
        y: display.physical.y + (rect.y - display.logical.y) * scale_y,
        width: rect.width * scale_x,
        height: rect.height * scale_y,
    }
}

fn window_physical_frame(native: &NativeWindow) -> Option<Rect> {
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    unsafe {
        (GetWindowRect(native.hwnd(), &mut rect) != 0).then(|| {
            to_rect(
                rect.left as f64,
                rect.top as f64,
                (rect.right - rect.left) as f64,
                (rect.bottom - rect.top) as f64,
            )
        })
    }
}

fn set_physical_frame(native: &NativeWindow, rect: Rect) {
    if !rect.is_valid() {
        return;
    }
    unsafe {
        SetWindowPos(
            native.hwnd(),
            HWND_TOP,
            rect.x.round() as i32,
            rect.y.round() as i32,
            rect.width.round() as i32,
            rect.height.round() as i32,
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_ASYNCWINDOWPOS,
        );
    }
}

pub fn window_frame(native: &NativeWindow) -> (f64, f64, f64, f64) {
    window_physical_frame(native)
        .map(|rect| (rect.x, rect.y, rect.width, rect.height))
        .unwrap_or_default()
}

pub fn set_window_frame(native: &NativeWindow, x: f64, y: f64, width: f64, height: f64) {
    set_physical_frame(native, to_rect(x, y, width, height));
}

pub fn window_logical_frame(native: &NativeWindow) -> (f64, f64, f64, f64) {
    let Some(physical) = window_physical_frame(native) else {
        return (0., 0., 0., 0.);
    };
    let displays = display_geometries();
    let logical = select_physical_display(physical, &displays)
        .map(|display| physical_to_logical(physical, display))
        .unwrap_or(physical);
    (logical.x, logical.y, logical.width, logical.height)
}

pub fn set_window_logical_frame(native: &NativeWindow, x: f64, y: f64, width: f64, height: f64) {
    let logical = to_rect(x, y, width, height);
    if !logical.is_valid() {
        return;
    }
    let displays = display_geometries();
    let physical = select_logical_display(logical, &displays, false)
        .map(|display| logical_to_physical(logical, display))
        .unwrap_or(logical);
    set_physical_frame(native, physical);
}

pub fn place_overlay_panel(
    native: &NativeWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    _level: isize,
) {
    let logical = to_rect(x, y, width, height);
    if !logical.is_valid() {
        return;
    }
    let displays = display_geometries();
    let physical = select_logical_display(logical, &displays, true)
        .map(|display| logical_to_physical(logical, display))
        .unwrap_or(logical);
    if !physical.is_valid() {
        return;
    }
    unsafe {
        SetWindowPos(
            native.hwnd(),
            HWND_TOPMOST,
            physical.x.round() as i32,
            physical.y.round() as i32,
            physical.width.round() as i32,
            physical.height.round() as i32,
            SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_ASYNCWINDOWPOS,
        );
    }
}

pub fn apply_panel_behavior(window: &Window, behavior: PanelBehavior) {
    let _ = (behavior.join_all_spaces, behavior.shadow);
    let Some(native) = native_window(window) else {
        return;
    };
    let insert_after = if behavior.level > 0 {
        HWND_TOPMOST
    } else {
        HWND_NOTOPMOST
    };
    unsafe {
        SetWindowPos(
            native.hwnd(),
            insert_after,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        );
    }
}

pub fn kick_display_link(_window: &Window) {}

pub fn hide_native(native: &NativeWindow) {
    unsafe {
        ShowWindowAsync(native.hwnd(), SW_HIDE);
    }
}

pub fn show_native(native: &NativeWindow) {
    unsafe {
        let command = if IsIconic(native.hwnd()) != 0 {
            SW_RESTORE
        } else {
            SW_SHOW
        };
        ShowWindowAsync(native.hwnd(), command);
    }
}

pub fn order_front_native(native: &NativeWindow) {
    unsafe {
        SetWindowPos(
            native.hwnd(),
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        );
    }
}

fn overlap_is_visible(first: Rect, second: Rect) -> bool {
    const MIN_VISIBLE: f64 = 80.;
    if !first.is_valid() || !second.is_valid() {
        return false;
    }
    let overlap_width =
        (first.x + first.width).min(second.x + second.width) - first.x.max(second.x);
    let overlap_height =
        (first.y + first.height).min(second.y + second.height) - first.y.max(second.y);
    overlap_width >= MIN_VISIBLE.min(first.width) && overlap_height >= MIN_VISIBLE.min(first.height)
}

pub fn frame_is_on_screen(x: f64, y: f64, width: f64, height: f64) -> bool {
    let frame = to_rect(x, y, width, height);
    if !frame.is_valid() {
        return false;
    }
    let displays = display_geometries();
    if displays.is_empty() {
        return true;
    }
    displays
        .iter()
        .any(|display| overlap_is_visible(frame, display.physical))
}

pub fn close_native(native: &NativeWindow) {
    unsafe {
        PostMessageW(native.hwnd(), WM_CLOSE, 0, 0);
    }
}

pub fn minimize_native(native: &NativeWindow) {
    unsafe {
        ShowWindowAsync(native.hwnd(), SW_MINIMIZE);
    }
}

pub fn zoom_native(native: &NativeWindow) {
    unsafe {
        let command = if IsZoomed(native.hwnd()) != 0 {
            SW_RESTORE
        } else {
            SW_MAXIMIZE
        };
        ShowWindowAsync(native.hwnd(), command);
    }
}

pub fn maximize_if_larger_than_work_area(window: &Window, cx: &gpui::App) {
    let Some(native) = native_window(window) else {
        return;
    };
    let Some(display) = window.display(cx) else {
        return;
    };
    let (_, _, width, height) = window_logical_frame(&native);
    let work = display.visible_bounds().size;
    if width > f64::from(f32::from(work.width)) || height > f64::from(f32::from(work.height)) {
        unsafe {
            ShowWindowAsync(native.hwnd(), SW_MAXIMIZE);
        }
    }
}

pub fn window_is_visible(window: &Window) -> bool {
    native_handle(window).is_some_and(|hwnd| unsafe { IsWindowVisible(hwnd as HWND) != 0 })
}

pub fn show_window_without_focus(window: &Window) {
    let Some(native) = native_window(window) else {
        return;
    };
    unsafe {
        ShowWindowAsync(native.hwnd(), SW_SHOWNOACTIVATE);
        SetWindowPos(
            native.hwnd(),
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_ASYNCWINDOWPOS,
        );
    }
}

pub fn window_number(window: &Window) -> Option<isize> {
    native_handle(window)
}

pub fn open_image_panel(extensions: &[&str]) -> Option<PathBuf> {
    let mut dialog = rfd::FileDialog::new();
    if !extensions.is_empty() {
        dialog = dialog.add_filter("Images", extensions);
    }
    dialog.pick_file()
}

pub fn open_audio_panel() -> Option<PathBuf> {
    rfd::FileDialog::new()
        .add_filter("Audio", &["mp3", "wav", "m4a", "ogg", "flac", "aac"])
        .pick_file()
}

pub fn confirm_dialog(
    title: &str,
    message: &str,
    accept: &str,
    cancel: &str,
    warning: bool,
) -> bool {
    let level = if warning {
        rfd::MessageLevel::Warning
    } else {
        rfd::MessageLevel::Info
    };
    let result = rfd::MessageDialog::new()
        .set_title(title)
        .set_description(message)
        .set_buttons(rfd::MessageButtons::OkCancelCustom(
            accept.to_string(),
            cancel.to_string(),
        ))
        .set_level(level)
        .show();
    super::confirmation_accepted(result, accept)
}

pub fn alert_dialog(title: &str, message: &str) {
    let _ = rfd::MessageDialog::new()
        .set_title(title)
        .set_description(message)
        .set_buttons(rfd::MessageButtons::Ok)
        .set_level(rfd::MessageLevel::Info)
        .show();
}

pub fn activate_app() {}

pub fn focus_capture_target_window(id: &scap_targets::WindowId) -> bool {
    let Some(window) = scap_targets::Window::from_id(id) else {
        return false;
    };
    let hwnd = window.raw_handle().inner().0 as HWND;
    if hwnd.is_null() {
        return false;
    }
    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindowAsync(hwnd, SW_RESTORE);
        }
        SetForegroundWindow(hwnd) != 0
    }
}

pub fn install_url_scheme_handler() {}

pub fn set_dock_icon(_png: &[u8]) {}

pub fn save_file_panel(suggested: &str, extensions: &[&str]) -> Option<PathBuf> {
    let mut dialog = rfd::FileDialog::new().set_file_name(suggested);
    if !extensions.is_empty() {
        dialog = dialog.add_filter("Export", extensions);
    }
    dialog.save_file()
}

pub fn copy_file_to_clipboard(_path: &Path) -> Result<(), String> {
    Err("Copy to clipboard is not available yet on Windows".into())
}

pub fn copy_image_to_clipboard(path: &Path) -> Result<(), String> {
    copy_file_to_clipboard(path)
}

pub fn desktop_picture_path() -> Option<PathBuf> {
    None
}

pub fn set_activation_policy(_regular: bool) -> bool {
    false
}

pub fn activation_policy() -> isize {
    -1
}

pub fn show_about_panel(_name: &str, _version: &str) {}

pub fn escape_hotkey_events() -> flume::Receiver<()> {
    flume::unbounded().1
}

pub fn register_escape_hotkey() {}

pub fn unregister_escape_hotkey() {}

#[cfg(test)]
mod tests {
    use super::{Rect, logical_to_physical, overlap_is_visible, physical_to_logical, to_rect};

    fn display(physical: Rect, logical: Rect) -> super::DisplayGeometry {
        super::DisplayGeometry { physical, logical }
    }

    #[test]
    fn converts_negative_mixed_dpi_monitor_coordinates() {
        let display = display(
            to_rect(-2560., -120., 2560., 1440.),
            to_rect(-1706.6666667, -80., 1706.6666667, 960.),
        );
        let logical = physical_to_logical(to_rect(-1280., 600., 1280., 720.), display);
        assert!((logical.x + 853.3333333).abs() < 0.01);
        assert!((logical.y - 400.).abs() < 0.01);
        assert!((logical.width - 853.3333333).abs() < 0.01);
        assert!((logical.height - 480.).abs() < 0.01);
        let physical = logical_to_physical(logical, display);
        assert!((physical.x + 1280.).abs() < 0.01);
        assert!((physical.y - 600.).abs() < 0.01);
        assert!((physical.width - 1280.).abs() < 0.01);
        assert!((physical.height - 720.).abs() < 0.01);
    }

    #[test]
    fn visible_frame_requires_grabbable_overlap() {
        let monitor = to_rect(-1920., 0., 1920., 1080.);
        assert!(overlap_is_visible(
            to_rect(-1910., 20., 100., 100.),
            monitor
        ));
        assert!(!overlap_is_visible(to_rect(-1990., 20., 70., 70.), monitor));
        assert!(!overlap_is_visible(
            to_rect(-1900., 1070., 500., 100.),
            monitor
        ));
        assert!(overlap_is_visible(
            to_rect(-1900., 1070., 500., 10.),
            monitor
        ));
        assert!(!overlap_is_visible(to_rect(0., 0., 0., 100.), monitor));
    }
}
