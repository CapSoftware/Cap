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
        // `CAP_PICKER_PROBE_HOLD=window` (or `display`, `area`) arms that
        // picker and leaves it up, for a script to drive the pointer over it.
        if let Ok(hold) = std::env::var("CAP_PICKER_PROBE_HOLD") {
            // `main` leaves the main window as it opened; `settings:<n>` opens
            // settings page n, for screenshots of the rest of the app.
            if hold == "main" {
                return;
            }
            if let Some(page) = hold.strip_prefix("settings:") {
                let page = page.parse::<usize>().unwrap_or(0);
                let page = crate::settings_window::Page::ALL
                    .get(page)
                    .copied()
                    .unwrap_or(crate::settings_window::Page::General);
                cx.update(|cx| app_windows::open_settings(page, cx));
                return;
            }
            let kind = match hold.as_str() {
                "display" => TargetType::Display,
                "area" => TargetType::Area,
                _ => TargetType::Window,
            };
            main.update(cx, |view, _, cx| view.arm_overlay(kind, cx))
                .ok();
            sleep(cx, 800).await;
            cx.update(|cx| {
                let overlays = cx.global::<app_windows::AppWindows>().overlays.clone();
                for (_, overlay) in overlays {
                    overlay
                        .update(cx, |_, window, _| window.activate_window())
                        .ok();
                }
            });
            return;
        }
        cx.update(app_windows::open_camera_window);
        sleep(cx, 800).await;

        let mut modes = Vec::new();
        let mut window_arrangement = None;
        let mut perf = None;
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
            let screen = screenshot(&output, label, cx).await;
            mode["backdrop"] = probe_backdrop(&output, label, screen.as_ref(), cx).await;
            modes.push(mode);
            if kind == TargetType::Window {
                window_arrangement = Some(probe_window_arrangement(&output, cx).await);
            }
            if kind == TargetType::Area {
                perf = Some(probe_perf(cx).await);
            }
            cx.update(app_windows::dismiss_target_overlays);
            sleep(cx, 400).await;
        }

        let arrangement_passed = window_arrangement
            .as_ref()
            .is_none_or(|report: &serde_json::Value| report["passed"].as_bool() != Some(false));
        let passed = arrangement_passed
            && modes.iter().all(|mode| {
                mode["cameraAboveOverlays"].as_bool() == Some(true)
                    && mode["backdrop"]["passed"].as_bool() != Some(false)
            });
        let report = serde_json::json!({
            "modes": modes,
            "windowArrangement": window_arrangement,
            "perf": perf,
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

async fn screenshot(
    output: &std::ffi::OsStr,
    label: &str,
    cx: &mut AsyncApp,
) -> Option<image::DynamicImage> {
    let directory = std::path::Path::new(output).parent()?;
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
            Some(image)
        }
        Ok(Err(error)) => {
            tracing::warn!("picker probe: {label} screenshot failed: {error:#}");
            None
        }
        Err(error) => {
            tracing::warn!(%error, "picker probe: {label} screenshot task failed");
            None
        }
    }
}

/// The mean per-channel difference between two captures of one display.
fn mean_difference(
    backdrop: &[u8],
    width: u32,
    height: u32,
    screen: &image::RgbImage,
) -> Option<f64> {
    if (screen.width(), screen.height()) != (width, height) {
        return None;
    }
    let (mut sum, mut count) = (0u64, 0u64);
    for (bgra, rgb) in backdrop.chunks_exact(4).zip(screen.pixels()) {
        for (a, b) in [bgra[2], bgra[1], bgra[0]].into_iter().zip(rgb.0) {
            sum += u64::from(a.abs_diff(b));
            count += 1;
        }
    }
    (count > 0).then(|| sum as f64 / count as f64)
}

/// Check the capture under the overlay's glass is of the desktop and not of
/// the overlay: the overlay dims and tints the whole display, so a capture
/// that left it out differs clearly from a screenshot that has it.
async fn probe_backdrop(
    output: &std::ffi::OsStr,
    label: &str,
    screen: Option<&image::DynamicImage>,
    cx: &mut AsyncApp,
) -> serde_json::Value {
    if !crate::overlay_backdrop::SUPPORTED {
        return serde_json::json!({ "skipped": "no capture without the overlay here" });
    }
    // The overlay over the display `screen` shows, so the two compare the
    // same desktop.
    let primary = scap_targets::Display::primary().id();
    let image = cx.update(|cx| {
        let overlay = cx
            .global::<app_windows::AppWindows>()
            .overlays
            .iter()
            .find(|(display, _)| *display == primary)
            .map(|(_, overlay)| *overlay)?;
        overlay
            .update(cx, |view, _, _| view.backdrop_image())
            .ok()
            .flatten()
    });
    let Some(image) = image else {
        return serde_json::json!({ "present": false, "passed": false });
    };
    let size = image.size(0);
    let (width, height) = (size.width.0 as u32, size.height.0 as u32);
    let bgra = image.as_bytes(0).unwrap_or_default();
    if let Some(directory) = std::path::Path::new(output).parent() {
        let rgba: Vec<u8> = bgra
            .chunks_exact(4)
            .flat_map(|px| [px[2], px[1], px[0], px[3]])
            .collect();
        if let Some(image) = image::RgbaImage::from_raw(width, height, rgba) {
            let _ = image.save(directory.join(format!("{label}-backdrop.png")));
        }
    }
    let difference =
        screen.and_then(|screen| mean_difference(bgra, width, height, &screen.to_rgb8()));
    serde_json::json!({
        "present": true,
        "size": [width, height],
        "meanDifference": difference,
        "passed": difference.is_some_and(|difference| difference > 6.),
    })
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

#[cfg(unix)]
fn cpu_secs() -> f64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    let usage = unsafe { usage.assume_init() };
    let secs = |time: libc::timeval| time.tv_sec as f64 + time.tv_usec as f64 / 1_000_000.0;
    secs(usage.ru_utime) + secs(usage.ru_stime)
}

#[cfg(windows)]
fn cpu_secs() -> f64 {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };

    let empty = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut creation, mut exit, mut kernel, mut user) = (empty, empty, empty, empty);
    unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    let secs = |time: FILETIME| {
        ((u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)) as f64
            / 10_000_000.0
    };
    secs(kernel) + secs(user)
}

fn cpu_percent_since(cpu: f64, wall: std::time::Instant) -> f64 {
    (cpu_secs() - cpu) / wall.elapsed().as_secs_f64() * 100.
}

/// Slide the drawn area back and forth for `millis`, the way a drag moves
/// the picker's panels, and return the process's CPU use meanwhile, as a
/// percentage of one core.
async fn drag_cpu(
    overlays: &[(
        scap_targets::DisplayId,
        WindowHandle<crate::target_overlay::OverlayWindow>,
    )],
    base: AreaRect,
    millis: u64,
    cx: &mut AsyncApp,
) -> f64 {
    let (cpu, wall) = (cpu_secs(), std::time::Instant::now());
    let mut step = 0u32;
    while wall.elapsed() < Duration::from_millis(millis) {
        let offset = 240. * (step as f32 * 0.05).sin();
        cx.update(|cx| {
            for (_, overlay) in overlays {
                overlay
                    .update(cx, |view, _, cx| view.probe_offset_area(base, offset, cx))
                    .ok();
            }
        });
        sleep(cx, 8).await;
        step += 1;
    }
    cpu_percent_since(cpu, wall)
}

/// What the picker costs: the process's CPU use with the area picker left
/// alone, and while its panels move, with and without the desktop capture
/// under their glass, measured back to back in one process.
async fn probe_perf(cx: &mut AsyncApp) -> serde_json::Value {
    let overlays = cx.update(|cx| cx.global::<app_windows::AppWindows>().overlays.clone());
    let base = AreaRect {
        x: 200.,
        y: 200.,
        width: 640.,
        height: 360.,
    };
    let (cpu, wall) = (cpu_secs(), std::time::Instant::now());
    sleep(cx, 3000).await;
    let idle = cpu_percent_since(cpu, wall);
    let dragging = drag_cpu(&overlays, base, 6000, cx).await;
    let capture_ms = crate::overlay_backdrop::last_capture_ms();
    crate::overlay_backdrop::set_disabled(true);
    let dragging_without_backdrop = drag_cpu(&overlays, base, 6000, cx).await;
    crate::overlay_backdrop::set_disabled(false);
    serde_json::json!({
        "idleCpuPercent": idle,
        "dragCpuPercent": dragging,
        "dragCpuPercentWithoutBackdrop": dragging_without_backdrop,
        "backdropCaptureMs": capture_ms,
    })
}
