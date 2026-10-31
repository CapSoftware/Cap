//! Moving, resizing and raising another app's window for the picker. Frames
//! are relative to a display, in the units `HoveredWindow::bounds` uses there:
//! logical points on macOS and Windows, pixels on X11.

use scap_targets::{DisplayId, WindowId};

use crate::target_overlay::AreaRect;

/// Whether the picker can shape other apps' windows here. Wayland gives no
/// client that power; macOS needs the Accessibility permission Cap holds.
pub fn can_arrange() -> bool {
    imp::can_arrange()
}

/// Move and resize window `id` to `frame`, relative to display `display`.
/// The app may clamp the result (minimum sizes, grid snapping): re-read the
/// window afterwards rather than trusting `frame`.
pub fn arrange(id: &WindowId, display: &DisplayId, frame: AreaRect) -> bool {
    let Some(display) = scap_targets::Display::from_id(display) else {
        return false;
    };
    imp::arrange(id, &display, frame)
}

pub fn raise(id: &WindowId) -> bool {
    imp::raise(id)
}

type Job = Box<dyn FnOnce() + Send>;

/// Run `job` after every job queued before it, on one worker thread. Moves
/// and restores go through here so a cancel's restore can never land before
/// a move the user started first.
pub fn in_order<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> impl std::future::Future<Output = Option<T>> {
    static QUEUE: std::sync::OnceLock<flume::Sender<Job>> = std::sync::OnceLock::new();
    let queue = QUEUE.get_or_init(|| {
        let (sender, receiver) = flume::unbounded::<Job>();
        let spawned = std::thread::Builder::new()
            .name("cap-window-arrange".into())
            .spawn(move || {
                for job in receiver.iter() {
                    job();
                }
            });
        if let Err(error) = spawned {
            tracing::error!(%error, "could not start the window arrange thread");
        }
        sender
    });
    let (done, result) = flume::bounded(1);
    let queued = queue.send(Box::new(move || {
        let _ = done.send(job());
    }));
    async move {
        queued.ok()?;
        result.recv_async().await.ok()
    }
}

/// How a window sits beyond its bounds (maximized), where bounds alone
/// cannot put it back.
#[derive(Clone, Copy)]
pub struct Placement(imp::RawPlacement);

pub fn placement(id: &WindowId) -> Option<Placement> {
    imp::placement(id).map(Placement)
}

/// Put `windows` back off the main thread (a move waits on the target app),
/// queued behind any move still running so it cannot land after them.
pub fn put_back_all(
    windows: Vec<crate::target_overlay::ArrangedWindow>,
    executor: &gpui::BackgroundExecutor,
) {
    if windows.is_empty() {
        return;
    }
    executor
        .spawn(in_order(move || {
            for window in windows {
                put_back(&window);
            }
        }))
        .detach();
}

pub fn put_back(original: &crate::target_overlay::ArrangedWindow) -> bool {
    let window = &original.window;
    if let Some(placement) = original.placement
        && imp::restore_placement(&window.id, &placement.0)
    {
        return true;
    }
    arrange(&window.id, &window.display_id, window.bounds)
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;

    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};

    use super::*;

    type AXUIElementRef = *const c_void;
    type AXValueRef = *const c_void;
    type AXError = i32;

    const AX_SUCCESS: AXError = 0;
    const AX_VALUE_CG_POINT: u32 = 1;
    const AX_VALUE_CG_SIZE: u32 = 2;

    #[repr(C)]
    struct Point {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    struct Size {
        width: f64,
        height: f64,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> AXError;
        fn AXUIElementSetAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: CFTypeRef,
        ) -> AXError;
        fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
        fn AXValueCreate(kind: u32, value: *const c_void) -> AXValueRef;
        /// Private but stable since 10.6, and the only way to tie an AX
        /// window to its CGWindowID.
        fn _AXUIElementGetWindow(element: AXUIElementRef, id: *mut u32) -> AXError;
    }

    pub fn can_arrange() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    pub type RawPlacement = std::convert::Infallible;

    pub fn placement(_: &WindowId) -> Option<RawPlacement> {
        None
    }

    pub fn restore_placement(_: &WindowId, placement: &RawPlacement) -> bool {
        match *placement {}
    }

    /// The AX element of window `id`, owned by the returned `CFType`.
    fn ax_window(id: &WindowId) -> Option<CFType> {
        let window = scap_targets::Window::from_id(id)?;
        let pid = window.raw_handle().owner_pid()?;
        let number: u32 = id.to_string().parse().ok()?;
        let app = unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(pid)) };
        let windows = unsafe {
            let mut value: CFTypeRef = std::ptr::null();
            let attribute = CFString::from_static_string("AXWindows");
            if AXUIElementCopyAttributeValue(
                app.as_CFTypeRef(),
                attribute.as_concrete_TypeRef(),
                &mut value,
            ) != AX_SUCCESS
                || value.is_null()
            {
                return None;
            }
            CFArray::<CFType>::wrap_under_create_rule(value as _)
        };
        windows.iter().find_map(|element| {
            let mut found = 0;
            let ok = unsafe { _AXUIElementGetWindow(element.as_CFTypeRef(), &mut found) };
            (ok == AX_SUCCESS && found == number).then(|| element.clone())
        })
    }

    fn set(element: &CFType, attribute: &'static str, kind: u32, value: *const c_void) -> bool {
        unsafe {
            let value = AXValueCreate(kind, value);
            if value.is_null() {
                return false;
            }
            let value = CFType::wrap_under_create_rule(value);
            let attribute = CFString::from_static_string(attribute);
            AXUIElementSetAttributeValue(
                element.as_CFTypeRef(),
                attribute.as_concrete_TypeRef(),
                value.as_CFTypeRef(),
            ) == AX_SUCCESS
        }
    }

    pub fn arrange(id: &WindowId, display: &scap_targets::Display, frame: AreaRect) -> bool {
        let Some(origin) = display.raw_handle().logical_bounds().map(|b| b.position()) else {
            return false;
        };
        let Some(element) = ax_window(id) else {
            tracing::warn!(%id, "arrange window: no accessibility element");
            return false;
        };
        let point = Point {
            x: origin.x() + f64::from(frame.x),
            y: origin.y() + f64::from(frame.y),
        };
        let size = Size {
            width: f64::from(frame.width),
            height: f64::from(frame.height),
        };
        let point = &point as *const Point as *const c_void;
        let size = &size as *const Size as *const c_void;
        // Position first so a growing window is not clamped by the screen
        // edge it starts against, then again because some apps re-centre
        // after a resize.
        let moved = set(&element, "AXPosition", AX_VALUE_CG_POINT, point);
        let sized = set(&element, "AXSize", AX_VALUE_CG_SIZE, size);
        set(&element, "AXPosition", AX_VALUE_CG_POINT, point);
        if !(moved && sized) {
            tracing::warn!(%id, moved, sized, "arrange window: the app refused part of the frame");
        }
        moved || sized
    }

    pub fn raise(id: &WindowId) -> bool {
        if let Some(element) = ax_window(id) {
            let action = CFString::from_static_string("AXRaise");
            unsafe {
                AXUIElementPerformAction(element.as_CFTypeRef(), action.as_concrete_TypeRef());
            }
        }
        crate::platform::focus_capture_target_window(id)
    }
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::{
        Foundation::{HWND, RECT},
        Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute},
        UI::WindowsAndMessaging::{
            GetWindowPlacement, GetWindowRect, IsZoomed, SW_RESTORE, SWP_NOACTIVATE, SWP_NOZORDER,
            SetWindowPlacement, SetWindowPos, ShowWindow, WINDOWPLACEMENT,
        },
    };

    use super::*;

    pub fn can_arrange() -> bool {
        true
    }

    pub type RawPlacement = WINDOWPLACEMENT;

    /// Only a maximized window needs its placement: resizing restores it,
    /// and its bounds then put it back as a large normal window.
    pub fn placement(id: &WindowId) -> Option<RawPlacement> {
        let hwnd = hwnd(id)?;
        unsafe {
            if IsZoomed(hwnd) == 0 {
                return None;
            }
            let mut placement: WINDOWPLACEMENT = std::mem::zeroed();
            placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
            (GetWindowPlacement(hwnd, &mut placement) != 0).then_some(placement)
        }
    }

    pub fn restore_placement(id: &WindowId, placement: &RawPlacement) -> bool {
        let Some(hwnd) = hwnd(id) else {
            return false;
        };
        unsafe { SetWindowPlacement(hwnd, placement) != 0 }
    }

    fn hwnd(id: &WindowId) -> Option<HWND> {
        let window = scap_targets::Window::from_id(id)?;
        let hwnd = window.raw_handle().inner().0 as HWND;
        (!hwnd.is_null()).then_some(hwnd)
    }

    pub fn arrange(id: &WindowId, display: &scap_targets::Display, frame: AreaRect) -> bool {
        let Some(hwnd) = hwnd(id) else {
            return false;
        };
        let (Some(physical), Some(logical)) = (
            display.raw_handle().physical_bounds(),
            display.raw_handle().logical_bounds(),
        ) else {
            return false;
        };
        let scale = physical.size().width() / logical.size().width().max(1.);
        let x = physical.position().x() + f64::from(frame.x) * scale;
        let y = physical.position().y() + f64::from(frame.y) * scale;
        let width = f64::from(frame.width) * scale;
        let height = f64::from(frame.height) * scale;
        unsafe {
            if IsZoomed(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            // `frame` is the visible window (DWM's extended frame bounds,
            // what scap-targets reports); SetWindowPos also counts the
            // invisible resize borders around it.
            let mut outer: RECT = std::mem::zeroed();
            let mut visible: RECT = std::mem::zeroed();
            let (left, top, right, bottom) = if GetWindowRect(hwnd, &mut outer) != 0
                && DwmGetWindowAttribute(
                    hwnd,
                    DWMWA_EXTENDED_FRAME_BOUNDS as u32,
                    &mut visible as *mut RECT as *mut _,
                    std::mem::size_of::<RECT>() as u32,
                ) == 0
            {
                (
                    visible.left - outer.left,
                    visible.top - outer.top,
                    outer.right - visible.right,
                    outer.bottom - visible.bottom,
                )
            } else {
                (0, 0, 0, 0)
            };
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                x.round() as i32 - left,
                y.round() as i32 - top,
                width.round() as i32 + left + right,
                height.round() as i32 + top + bottom,
                SWP_NOZORDER | SWP_NOACTIVATE,
            ) != 0
        }
    }

    pub fn raise(id: &WindowId) -> bool {
        crate::platform::focus_capture_target_window(id)
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use x11rb::connection::Connection as _;
    use x11rb::protocol::xproto::{ClientMessageEvent, ConnectionExt as _, EventMask};

    use super::*;

    pub fn can_arrange() -> bool {
        !cap_recording::screenshot::uses_wayland_portal()
    }

    pub type RawPlacement = std::convert::Infallible;

    pub fn placement(_: &WindowId) -> Option<RawPlacement> {
        None
    }

    pub fn restore_placement(_: &WindowId, placement: &RawPlacement) -> bool {
        match *placement {}
    }

    fn send(window: u32, message: &[u8], data: [u32; 5]) -> anyhow::Result<()> {
        let (connection, screen) = x11rb::connect(None)?;
        let root = connection.setup().roots[screen].root;
        let atom = connection.intern_atom(false, message)?.reply()?.atom;
        let event = ClientMessageEvent::new(32, window, atom, data);
        connection
            .send_event(
                false,
                root,
                EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                event,
            )?
            .check()?;
        connection.flush()?;
        Ok(())
    }

    pub fn arrange(id: &WindowId, display: &scap_targets::Display, frame: AreaRect) -> bool {
        if !can_arrange() {
            return false;
        }
        let Ok(window) = id.to_string().parse::<u32>() else {
            return false;
        };
        let Some(origin) = display.raw_handle().physical_bounds().map(|b| b.position()) else {
            return false;
        };
        // StaticGravity, so x/y place the client area as scap-targets
        // measures it; x, y, width and height present; from a pager.
        const STATIC_GRAVITY: u32 = 10;
        let flags = STATIC_GRAVITY | (0b1111 << 8) | (2 << 12);
        let data = [
            flags,
            (origin.x() + f64::from(frame.x)).round() as i32 as u32,
            (origin.y() + f64::from(frame.y)).round() as i32 as u32,
            frame.width.round().max(1.) as u32,
            frame.height.round().max(1.) as u32,
        ];
        match send(window, b"_NET_MOVERESIZE_WINDOW", data) {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!(%error, %id, "arrange window: the window manager refused");
                false
            }
        }
    }

    pub fn raise(id: &WindowId) -> bool {
        let Ok(window) = id.to_string().parse::<u32>() else {
            return false;
        };
        send(window, b"_NET_ACTIVE_WINDOW", [2, 0, 0, 0, 0]).is_ok()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn queued_jobs_run_in_the_order_they_were_queued() {
        let order = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let slow = order.clone();
        let first = super::in_order(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            slow.lock().unwrap().push("move");
        });
        let fast = order.clone();
        let second = super::in_order(move || fast.lock().unwrap().push("restore"));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            assert_eq!(second.await, Some(()));
            assert_eq!(first.await, Some(()));
        });
        assert_eq!(*order.lock().unwrap(), ["move", "restore"]);
    }
}
