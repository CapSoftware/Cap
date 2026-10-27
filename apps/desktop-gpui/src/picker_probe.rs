use std::time::Duration;

use gpui::{App, AsyncApp, WindowHandle};

use crate::{
    app_windows,
    main_window::{MainWindow, TargetType},
    target_overlay::AreaRect,
};

/// `CAP_PICKER_PROBE_OUTPUT=<path>`: open the camera bubble, arm each picker
/// mode, activate an overlay the way a click does, and write the native
/// front-to-back order of Cap's windows so CI can check the camera stays on
/// top.
pub fn run(main: WindowHandle<MainWindow>, cx: &mut App) {
    let Some(output) = std::env::var_os("CAP_PICKER_PROBE_OUTPUT") else {
        return;
    };
    cx.spawn(async move |cx| {
        let delay = std::env::var("CAP_PICKER_PROBE_DELAY_MS")
            .ok()
            .and_then(|delay| delay.parse().ok())
            .unwrap_or(2000);
        sleep(cx, delay).await;
        cx.update(app_windows::open_camera_window);
        sleep(cx, 800).await;

        let mut modes = Vec::new();
        for (label, kind) in [
            ("display", TargetType::Display),
            ("window", TargetType::Window),
            ("area", TargetType::Area),
        ] {
            main.update(cx, |view, _, cx| view.arm_overlay(kind, cx))
                .ok();
            sleep(cx, 800).await;
            if kind == TargetType::Area {
                cx.update(|cx| {
                    app_windows::seed_area_selection(
                        None,
                        AreaRect {
                            x: 200.,
                            y: 200.,
                            width: 640.,
                            height: 360.,
                        },
                        cx,
                    )
                });
            }
            cx.update(|cx| {
                for (_, overlay) in cx.global::<app_windows::AppWindows>().overlays.clone() {
                    overlay
                        .update(cx, |_, window, _| window.activate_window())
                        .ok();
                }
            });
            sleep(cx, 800).await;
            modes.push(cx.update(|cx| probe_mode(label, cx)));
            cx.update(app_windows::dismiss_target_overlays);
            sleep(cx, 400).await;
        }

        let passed = modes
            .iter()
            .all(|mode| mode["cameraAboveOverlays"].as_bool() == Some(true));
        let report = serde_json::json!({ "passed": passed, "modes": modes });
        if let Err(error) = std::fs::write(output, report.to_string()) {
            tracing::error!(%error, "Could not write picker probe results");
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

async fn sleep(cx: &mut AsyncApp, millis: u64) {
    cx.background_executor()
        .timer(Duration::from_millis(millis))
        .await;
}

fn probe_mode(label: &str, cx: &mut App) -> serde_json::Value {
    let windows = cx.global::<app_windows::AppWindows>();
    let camera = windows.camera;
    let overlays = windows.overlays.clone();
    let camera_id = camera.and_then(|camera| {
        camera
            .update(cx, |_, window, _| native_id(window))
            .ok()
            .flatten()
    });
    let overlay_ids: Vec<isize> = overlays
        .iter()
        .filter_map(|(_, overlay)| {
            overlay
                .update(cx, |_, window, _| native_id(window))
                .ok()
                .flatten()
        })
        .collect();
    let stacking = own_window_stacking();
    let position = |id: isize| stacking.iter().position(|current| *current == id);
    let camera_position = camera_id.and_then(position);
    let overlay_positions: Vec<Option<usize>> =
        overlay_ids.iter().map(|id| position(*id)).collect();
    let camera_above = camera_position.is_some_and(|camera| {
        !overlay_positions.is_empty()
            && overlay_positions
                .iter()
                .all(|overlay| overlay.is_some_and(|overlay| camera < overlay))
    });
    serde_json::json!({
        "mode": label,
        "camera": camera_id,
        "overlays": overlay_ids,
        "stackingFrontToBack": stacking,
        "cameraAboveOverlays": camera_above,
    })
}

#[cfg(target_os = "macos")]
fn native_id(window: &gpui::Window) -> Option<isize> {
    crate::platform::window_number(window)
}

#[cfg(target_os = "windows")]
fn native_id(window: &gpui::Window) -> Option<isize> {
    crate::platform::window_number(window)
}

#[cfg(target_os = "linux")]
fn native_id(window: &gpui::Window) -> Option<isize> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Xlib(handle) => isize::try_from(handle.window).ok(),
        RawWindowHandle::Xcb(handle) => isize::try_from(handle.window.get()).ok(),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn own_window_stacking() -> Vec<isize> {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
        static kCGWindowOwnerPID: CFStringRef;
        static kCGWindowNumber: CFStringRef;
    }
    const ON_SCREEN_ONLY: u32 = 1 << 0;

    let list = unsafe {
        let raw = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY, 0);
        if raw.is_null() {
            return Vec::new();
        }
        CFArray::<CFDictionary<CFString, CFType>>::wrap_under_create_rule(raw)
    };
    let (owner_key, number_key) = unsafe {
        (
            CFString::wrap_under_get_rule(kCGWindowOwnerPID),
            CFString::wrap_under_get_rule(kCGWindowNumber),
        )
    };
    let pid = i64::from(std::process::id());
    list.iter()
        .filter_map(|window| {
            let field = |key: &CFString| window.find(key)?.downcast::<CFNumber>()?.to_i64();
            (field(&owner_key)? == pid).then_some(())?;
            isize::try_from(field(&number_key)?).ok()
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn own_window_stacking() -> Vec<isize> {
    use windows_sys::Win32::{
        Foundation::{BOOL, HWND, LPARAM, TRUE},
        UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible},
    };

    unsafe extern "system" fn collect(window: HWND, data: LPARAM) -> BOOL {
        let windows = unsafe { &mut *(data as *mut Vec<isize>) };
        let mut owner = 0;
        unsafe { GetWindowThreadProcessId(window, &mut owner) };
        if owner == std::process::id() && unsafe { IsWindowVisible(window) } != 0 {
            windows.push(window as isize);
        }
        TRUE
    }

    let mut windows = Vec::new();
    unsafe {
        EnumWindows(Some(collect), std::ptr::addr_of_mut!(windows) as isize);
    }
    windows
}

#[cfg(target_os = "linux")]
fn own_window_stacking() -> Vec<isize> {
    use x11rb::connection::Connection as _;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _};

    let Ok((connection, screen)) = x11rb::connect(None) else {
        return Vec::new();
    };
    let root = connection.setup().roots[screen].root;
    let stacking = connection
        .intern_atom(false, b"_NET_CLIENT_LIST_STACKING")
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .and_then(|atom| {
            connection
                .get_property(false, root, atom.atom, AtomEnum::WINDOW, 0, u32::MAX)
                .ok()?
                .reply()
                .ok()
        })
        .and_then(|reply| reply.value32().map(|values| values.collect::<Vec<u32>>()))
        .filter(|values| !values.is_empty());
    let bottom_to_top = match stacking {
        Some(values) => values,
        None => connection
            .query_tree(root)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|tree| tree.children)
            .unwrap_or_default(),
    };
    bottom_to_top
        .into_iter()
        .rev()
        .filter_map(|window| isize::try_from(window).ok())
        .collect()
}
