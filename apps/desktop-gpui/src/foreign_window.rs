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

/// Bring window `id` and its app to the front.
pub fn raise(id: &WindowId) -> bool {
    imp::raise(id)
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
            GetWindowRect, IsZoomed, SW_RESTORE, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos,
            ShowWindow,
        },
    };

    use super::*;

    pub fn can_arrange() -> bool {
        true
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
