use std::time::Duration;

use gpui::{App, AsyncApp, WindowHandle};

use crate::{
    app_windows,
    main_window::{MainWindow, TargetType},
    target_overlay::AreaRect,
};

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
        let mut window_arrangement = None;
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
            // Opening an overlay already raises the camera, so hand focus to
            // the main window first: the activation below then has to raise
            // it again by itself.
            main.update(cx, |_, window, _| window.activate_window())
                .ok();
            sleep(cx, 600).await;
            let overlays = cx.update(|cx| cx.global::<app_windows::AppWindows>().overlays.clone());
            let inactive_before = cx.update(|cx| {
                overlays.iter().all(|(_, overlay)| {
                    overlay
                        .update(cx, |_, window, _| !window.is_window_active())
                        .unwrap_or(true)
                })
            });
            cx.update(|cx| {
                for (_, overlay) in &overlays {
                    overlay
                        .update(cx, |_, window, _| window.activate_window())
                        .ok();
                }
            });
            sleep(cx, 800).await;
            let mut mode = cx.update(|cx| probe_mode(label, cx));
            mode["overlayInactiveBeforeActivation"] = inactive_before.into();
            modes.push(mode);
            screenshot(&output, label, cx).await;
            if kind == TargetType::Window {
                window_arrangement = Some(probe_window_arrangement(&output, cx).await);
            }
            cx.update(app_windows::dismiss_target_overlays);
            sleep(cx, 400).await;
        }

        let arrangement_passed = window_arrangement
            .as_ref()
            .is_none_or(|report: &serde_json::Value| report["passed"].as_bool() != Some(false));
        let passed = arrangement_passed
            && modes
                .iter()
                .all(|mode| mode["cameraAboveOverlays"].as_bool() == Some(true));
        let report = serde_json::json!({
            "modes": modes,
            "windowArrangement": window_arrangement,
        });
        // The verdict leads so `run.sh` can read it without parsing JSON:
        // nested checks carry `passed` keys of their own.
        if let Err(error) = std::fs::write(
            output,
            format!("{{\"passed\":{passed},{}", &report.to_string()[1..]),
        ) {
            tracing::error!(%error, "Could not write picker probe results");
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

struct StackEntry {
    id: isize,
    level: Option<i64>,
}

fn read_window(id: &scap_targets::WindowId) -> Option<crate::target_overlay::AreaRect> {
    let window = scap_targets::Window::from_id(id)?;
    crate::target_overlay::HoveredWindow::from_window(&window).map(|window| window.bounds)
}

fn rect_json(rect: Option<AreaRect>) -> serde_json::Value {
    rect.map_or(serde_json::Value::Null, |rect| {
        serde_json::json!([rect.x, rect.y, rect.width, rect.height])
    })
}

/// Drive the picked window through the overlay the way its menu and Focus
/// toggle do: 16:9, Focus on, then dismiss. Skipped where Cap cannot shape
/// other apps' windows (Wayland, or macOS without Accessibility).
async fn probe_window_arrangement(
    output: &std::ffi::OsStr,
    cx: &mut AsyncApp,
) -> serde_json::Value {
    if !crate::foreign_window::can_arrange() {
        return serde_json::json!({ "skipped": "cannot arrange other apps' windows here" });
    }
    // The workflow opens one of these; pick it outright rather than relying
    // on where the runner left the cursor.
    let test_window = scap_targets::Window::list().into_iter().find(|window| {
        window.owner_name().is_some_and(|owner| {
            let owner = owner.to_lowercase();
            ["textedit", "notepad", "xterm"]
                .iter()
                .any(|name| owner.contains(name))
        })
    });
    let picked = cx.update(|cx| {
        let select = crate::target_overlay::TargetSelect::global(cx);
        if let Some(window) = test_window
            .as_ref()
            .and_then(crate::target_overlay::HoveredWindow::from_window)
        {
            select.update(cx, |select, cx| select.set_pinned(window, cx));
        }
        select.read(cx).active_window().cloned()
    });
    let Some(picked) = picked else {
        return serde_json::json!({ "passed": false, "error": "no window to arrange" });
    };
    let overlay = cx.update(|cx| {
        cx.global::<app_windows::AppWindows>()
            .overlays
            .iter()
            .find(|(display, _)| *display == picked.display_id)
            .map(|(_, overlay)| *overlay)
    });
    let Some(overlay) = overlay else {
        return serde_json::json!({ "passed": false, "error": "no overlay on the window's display" });
    };
    let display = scap_targets::Display::from_id(&picked.display_id);
    let display_size = display
        .as_ref()
        .and_then(|display| display.raw_handle().logical_bounds())
        .map(|bounds| (bounds.size().width() as f32, bounds.size().height() as f32));
    let before = Some(picked.bounds);

    // `window_arrange::RATIOS` lists 16:9 second.
    overlay
        .update(cx, |view, _, cx| view.choose_window_size(1, cx))
        .ok();
    sleep(cx, 1500).await;
    let shaped = read_window(&picked.id);
    let ratio_ok =
        shaped.is_some_and(|rect| (rect.width / rect.height / (16. / 9.) - 1.).abs() < 0.04);
    let inside = |rect: Option<AreaRect>| {
        rect.zip(display_size)
            .is_some_and(|(rect, (width, height))| {
                rect.x >= -1.
                    && rect.y >= -1.
                    && rect.x + rect.width <= width + 1.
                    && rect.y + rect.height <= height + 1.
            })
    };
    screenshot(output, "window-16x9", cx).await;

    overlay
        .update(cx, |view, _, cx| view.set_focus(true, cx))
        .ok();
    sleep(cx, 1500).await;
    let focused = read_window(&picked.id);
    let centred = focused.zip(display_size).is_some_and(|(rect, (width, _))| {
        (rect.x + rect.width / 2. - width / 2.).abs() < width * 0.04
    });
    screenshot(output, "window-focus", cx).await;
    let near = |a: Option<AreaRect>, b: Option<AreaRect>| {
        a.zip(b).is_some_and(|(a, b)| {
            (a.x - b.x).abs() < 6.
                && (a.y - b.y).abs() < 6.
                && (a.width - b.width).abs() < 6.
                && (a.height - b.height).abs() < 6.
        })
    };
    overlay
        .update(cx, |view, _, cx| view.set_focus(false, cx))
        .ok();
    sleep(cx, 1500).await;
    let unfocused = read_window(&picked.id);
    let unfocused_ok = !near(unfocused, focused) || near(focused, before);

    // Dismissed with the window still moved: only the dismissal can put it
    // back.
    overlay
        .update(cx, |view, _, cx| view.set_focus(true, cx))
        .ok();
    sleep(cx, 1500).await;
    let moved = !near(read_window(&picked.id), before);
    cx.update(app_windows::dismiss_target_overlays);
    sleep(cx, 1500).await;
    let restored = read_window(&picked.id);
    let restored_ok = moved && near(restored, before);
    serde_json::json!({
        "passed": ratio_ok
            && inside(shaped)
            && centred
            && inside(focused)
            && unfocused_ok
            && restored_ok,
        "before": rect_json(before),
        "sixteenByNine": rect_json(shaped),
        "ratioOk": ratio_ok,
        "focused": rect_json(focused),
        "centred": centred,
        "unfocused": rect_json(unfocused),
        "unfocusedOk": unfocused_ok,
        "movedBeforeDismiss": moved,
        "restored": rect_json(restored),
        "restoredOk": restored_ok,
    })
}

async fn screenshot(output: &std::ffi::OsStr, label: &str, cx: &mut AsyncApp) {
    let Some(directory) = std::path::Path::new(output).parent() else {
        return;
    };
    let path = directory.join(format!("{label}.png"));
    let target = cap_recording::sources::screen_capture::ScreenCaptureTarget::Display {
        id: scap_targets::Display::primary().id(),
    };
    let image = gpui_tokio::Tokio::spawn(cx, async move {
        cap_recording::screenshot::capture_screenshot(target).await
    })
    .await;
    match image {
        Ok(Ok(image)) => {
            if let Err(error) = image.save(&path) {
                tracing::warn!(%error, "picker probe: could not save {label} screenshot");
            }
        }
        Ok(Err(error)) => tracing::warn!("picker probe: {label} screenshot failed: {error:#}"),
        Err(error) => tracing::warn!(%error, "picker probe: {label} screenshot task failed"),
    }
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
    let ours: Vec<isize> = camera_id
        .into_iter()
        .chain(overlay_ids.iter().copied())
        .collect();
    let stacking = own_window_stacking(&ours);
    let position = |id: isize| stacking.iter().position(|entry| entry.id == id);
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
        "stackingFrontToBack": stacking
            .iter()
            .map(|entry| serde_json::json!({ "id": entry.id, "level": entry.level }))
            .collect::<Vec<_>>(),
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
fn own_window_stacking(_ours: &[isize]) -> Vec<StackEntry> {
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
        static kCGWindowLayer: CFStringRef;
    }
    const ON_SCREEN_ONLY: u32 = 1 << 0;

    let list = unsafe {
        let raw = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY, 0);
        if raw.is_null() {
            return Vec::new();
        }
        CFArray::<CFDictionary<CFString, CFType>>::wrap_under_create_rule(raw)
    };
    let (owner_key, number_key, layer_key) = unsafe {
        (
            CFString::wrap_under_get_rule(kCGWindowOwnerPID),
            CFString::wrap_under_get_rule(kCGWindowNumber),
            CFString::wrap_under_get_rule(kCGWindowLayer),
        )
    };
    let pid = i64::from(std::process::id());
    list.iter()
        .filter_map(|window| {
            let field = |key: &CFString| window.find(key)?.downcast::<CFNumber>()?.to_i64();
            (field(&owner_key)? == pid).then_some(())?;
            Some(StackEntry {
                id: isize::try_from(field(&number_key)?).ok()?,
                level: field(&layer_key),
            })
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn own_window_stacking(_ours: &[isize]) -> Vec<StackEntry> {
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

    let mut windows: Vec<isize> = Vec::new();
    unsafe {
        EnumWindows(Some(collect), std::ptr::addr_of_mut!(windows) as isize);
    }
    windows
        .into_iter()
        .map(|id| StackEntry { id, level: None })
        .collect()
}

/// Override-redirect windows (the camera and the overlays) never appear in
/// the window manager's client list, so this walks the real stacking order:
/// the root's children bottom to top, each one standing for whichever of our
/// windows it is or frames.
#[cfg(target_os = "linux")]
fn own_window_stacking(ours: &[isize]) -> Vec<StackEntry> {
    use x11rb::connection::Connection as _;
    use x11rb::protocol::xproto::ConnectionExt as _;

    let Ok((connection, screen)) = x11rb::connect(None) else {
        return Vec::new();
    };
    let root = connection.setup().roots[screen].root;
    let children = |window: u32| -> Vec<u32> {
        connection
            .query_tree(window)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|tree| tree.children)
            .unwrap_or_default()
    };
    let is_ours = |window: u32| ours.contains(&(window as isize));
    let mut stacking = Vec::new();
    for top_level in children(root).into_iter().rev() {
        let mut found = is_ours(top_level).then_some(top_level);
        let mut frontier = vec![top_level];
        for _ in 0..3 {
            if found.is_some() {
                break;
            }
            frontier = frontier.into_iter().flat_map(&children).collect();
            found = frontier.iter().copied().find(|window| is_ours(*window));
        }
        if let Some(window) = found {
            stacking.push(StackEntry {
                id: window as isize,
                level: None,
            });
        }
    }
    stacking
}
