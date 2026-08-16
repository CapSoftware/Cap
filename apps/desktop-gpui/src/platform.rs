//! Native window treatment gpui does not expose.
//!
//! The Tauri app gives its windows their panel behavior in
//! `apps/desktop/src-tauri/src/windows.rs`: converted to NSPanel via
//! `tauri_nspanel`, raised to a specific window level, joined to all Spaces.
//! gpui exposes none of that, but its `Window` implements
//! `raw_window_handle::HasWindowHandle`, and on macOS the AppKit handle's
//! `ns_view` reaches the `NSWindow`, where the same AppKit calls apply. We skip
//! the NSPanel class swizzle -- level + collection behavior covers the
//! observable behavior (always-on-top, follows Spaces); the difference is noted
//! in the README.
//!
//! Everything here must run on the main thread. gpui's foreground executor is
//! the main thread, and every caller sits inside a `Window` update, so that
//! holds by construction.

/// `MAIN_PANEL_LEVEL` in `windows.rs`: above normal windows and the Dock's
/// auto-hide reveal, below context menus.
pub const MAIN_WINDOW_LEVEL: isize = 100;

#[derive(Debug, Clone, Copy)]
pub struct PanelBehavior {
    pub level: isize,
    /// `CanJoinAllSpaces | FullScreenPrimary`, the combination every Cap panel
    /// window uses.
    pub join_all_spaces: bool,
    /// Borderless NSWindows get a system shadow; the recording controls bar is
    /// drawn shadowless (`.shadow(false)` in the Tauri builder).
    pub shadow: bool,
}

#[cfg(target_os = "macos")]
pub use mac::*;

#[cfg(target_os = "macos")]
mod mac {
    use gpui::Window;
    use objc2::rc::Id;
    use objc2::runtime::{AnyObject, Sel};
    use objc2_app_kit::{NSView, NSWindow, NSWindowCollectionBehavior};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    use super::PanelBehavior;

    /// Repair gpui's per-window display link on macOS 26.
    ///
    /// gpui only starts a window's CVDisplayLink when `occlusionState()`
    /// contains the documented `NSWindowOcclusionStateVisible` bit (`0x2`).
    /// On macOS 26 AppKit reports visible windows with a new undocumented bit
    /// (`0x2000`) and, for windows like ours, no longer sets `0x2` -- so no
    /// window in this app ever got a frame callback: first paint only, then
    /// frozen (bar timer stuck on "Starting", camera preview never showing a
    /// frame). Verified empirically via `window_diagnostics`.
    ///
    /// The shim overrides `occlusionState` on gpui's own window subclasses
    /// (`GPUIWindow`, `GPUIPanel`) to OR the documented bit back in whenever
    /// AppKit reports any visibility at all. gpui's gate then passes and its
    /// own occlusion handling keeps working (a truly occluded window still
    /// reports 0 and stops its link). Remove when the gpui pin understands the
    /// macOS 26 bit.
    ///
    /// Call once, before any window opens; [`kick_display_link`] re-fires the
    /// (self-delegating) occlusion handler for windows that opened before the
    /// state ever changed.
    pub fn install_occlusion_shim() {
        use objc2::ffi::{class_addMethod, objc_msgSendSuper, objc_super};

        unsafe extern "C" fn occlusion_state_shim(this: *mut AnyObject, sel: Sel) -> usize {
            unsafe {
                let class = (*this).class();
                let Some(superclass) = class.superclass() else {
                    return 0;
                };
                let mut sup = objc_super {
                    receiver: this.cast(),
                    super_class: (superclass as *const objc2::runtime::AnyClass).cast(),
                };
                let send: unsafe extern "C" fn(*mut objc_super, Sel) -> usize =
                    std::mem::transmute(objc_msgSendSuper as unsafe extern "C" fn());
                let raw = send(&mut sup, sel);
                if raw != 0 { raw | 0x2 } else { raw }
            }
        }

        for name in ["GPUIWindow", "GPUIPanel"] {
            let Some(class) = objc2::runtime::AnyClass::get(name) else {
                // The class registers lazily with the first window; the caller
                // runs before that only if nothing was opened -- harmless, the
                // second call from `kick_display_link` retries.
                continue;
            };
            let added = unsafe {
                class_addMethod(
                    (class as *const objc2::runtime::AnyClass as *mut objc2::ffi::objc_class)
                        .cast(),
                    objc2::sel!(occlusionState).as_ptr(),
                    Some(std::mem::transmute::<
                        unsafe extern "C" fn(*mut AnyObject, Sel) -> usize,
                        unsafe extern "C" fn(),
                    >(occlusion_state_shim)),
                    c"Q@:".as_ptr(),
                )
            };
            if added {
                tracing::info!("installed macOS 26 occlusion shim on {name}");
            }
        }
    }

    /// Re-run gpui's occlusion handler so a window whose display link never
    /// started (see [`install_occlusion_shim`]) evaluates the gate again. gpui
    /// windows are their own delegate, so the selector lives on the window.
    pub fn kick_display_link(window: &Window) {
        install_occlusion_shim();
        if let Some(ns_window) = ns_window(window) {
            unsafe {
                let _: () = objc2::msg_send![&*ns_window, windowDidChangeOcclusionState: std::ptr::null_mut::<AnyObject>()];
            }
        }
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGWindowLevelForKey(key: i32) -> i32;
    }

    /// The level the recording controls bar runs at.
    ///
    /// `windows.rs` computes this as `CGWindowLevelForKey(10)` under a constant
    /// it names `kCGMaximumWindowLevelKey` -- but key 10 is actually
    /// `kCGModalPanelWindowLevelKey` (maximum is 14), so the Tauri bar really
    /// runs at level 8, not the maximum. Reproduced verbatim: parity with the
    /// shipping app beats fixing its constant from over here.
    pub fn recording_controls_level() -> isize {
        unsafe { CGWindowLevelForKey(10) as isize }
    }

    /// The `NSWindow` behind a gpui window.
    pub fn ns_window(window: &Window) -> Option<Id<NSWindow>> {
        // Fully qualified: `Window` also has an inherent `window_handle()`
        // returning gpui's own `AnyWindowHandle`.
        let handle = HasWindowHandle::window_handle(window).ok()?;
        let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
            return None;
        };
        let view = appkit.ns_view.as_ptr() as *const NSView;
        // The view pointer is valid for the lifetime of the gpui window, and we
        // are inside a live `&Window`.
        unsafe { (*view).window() }
    }

    pub fn apply_panel_behavior(window: &Window, behavior: PanelBehavior) {
        // Every Cap window comes through here right after opening, which makes
        // it the one reliable place to repair the display link (see
        // `install_occlusion_shim`).
        kick_display_link(window);
        let Some(ns_window) = ns_window(window) else {
            tracing::error!("no NSWindow behind gpui window; panel behavior not applied");
            return;
        };
        ns_window.setLevel(behavior.level);
        tracing::debug!(
            requested = behavior.level,
            actual = unsafe { ns_window.level() },
            "panel level applied"
        );
        if behavior.join_all_spaces {
            unsafe {
                ns_window.setCollectionBehavior(
                    NSWindowCollectionBehavior::CanJoinAllSpaces
                        | NSWindowCollectionBehavior::FullScreenPrimary,
                );
            }
        }
        ns_window.setHasShadow(behavior.shadow);
    }

    /// `orderOut:` -- hide without closing, the way the Tauri main window hides
    /// while the recording controls bar is up.
    pub fn hide_window(window: &Window) {
        if let Some(ns_window) = ns_window(window) {
            ns_window.orderOut(None);
        }
    }

    /// Reverse of [`hide_window`].
    pub fn show_window(window: &Window) {
        if let Some(ns_window) = ns_window(window) {
            ns_window.makeKeyAndOrderFront(None);
        }
    }

    /// Show without stealing key status -- `orderFrontRegardless`, what the
    /// Tauri app calls on the recording controls panel.
    pub fn show_window_without_focus(window: &Window) {
        if let Some(ns_window) = ns_window(window) {
            unsafe { ns_window.orderFrontRegardless() };
        }
    }

    /// The CGWindowID, which is also what `scap_targets::WindowId` wraps on
    /// macOS -- used to exclude our own controls bar from the capture.
    pub fn window_number(window: &Window) -> Option<isize> {
        ns_window(window).map(|w| unsafe { w.windowNumber() })
    }

    /// One-line diagnostic of everything AppKit weighs into occlusion
    /// visibility -- how the macOS 26 display-link failure was diagnosed; keep
    /// it for the next platform mystery.
    #[allow(dead_code)]
    pub fn window_diagnostics(window: &Window) -> Option<String> {
        let w = ns_window(window)?;
        Some(format!(
            "occlusion_raw={:#x} visible={} on_active_space={} alpha={} level={} number={}",
            w.occlusionState().bits(),
            w.isVisible(),
            unsafe { w.isOnActiveSpace() },
            unsafe { w.alphaValue() },
            unsafe { w.level() },
            unsafe { w.windowNumber() },
        ))
    }
}

#[cfg(not(target_os = "macos"))]
mod stub {
    use gpui::Window;

    use super::PanelBehavior;

    pub fn recording_controls_level() -> isize {
        0
    }
    pub fn install_occlusion_shim() {}
    pub fn kick_display_link(_window: &Window) {}
    pub fn apply_panel_behavior(_window: &Window, _behavior: PanelBehavior) {}
    pub fn hide_window(_window: &Window) {}
    pub fn show_window(_window: &Window) {}
    pub fn show_window_without_focus(_window: &Window) {}
    pub fn window_number(_window: &Window) -> Option<isize> {
        None
    }
}

#[cfg(not(target_os = "macos"))]
pub use stub::*;
