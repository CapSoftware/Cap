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

/// Which native material sits behind a window's content.
///
/// `applyMacOSWindowMaterial` in
/// `apps/desktop/src/utils/macos-window-material.ts` picks between exactly
/// these two: `visualSystem = majorVersion >= 26 ? "liquid-glass" :
/// "vibrancy"`. The main window is material `"panel"`, radius 16 on both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterialKind {
    /// `NSGlassEffectView`, macOS 26+ only.
    LiquidGlass,
    /// `NSVisualEffectView` with the `windowBackground` material -- the
    /// `setEffects({ effects: [Effect.WindowBackground], ... })` fallback.
    Vibrancy,
}

/// The material [`install_window_material`] actually installed on the main
/// window, so `render` can pick the tint that belongs over it. `None` means
/// the shell paints its opaque `gray-1` self (non-mac, or the install failed).
#[derive(Debug, Clone, Copy, Default)]
pub struct WindowMaterial(pub Option<MaterialKind>);

impl gpui::Global for WindowMaterial {}

pub fn active_material(cx: &gpui::App) -> Option<MaterialKind> {
    cx.try_global::<WindowMaterial>()
        .and_then(|material| material.0)
}

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

    use super::{MaterialKind, PanelBehavior};

    /// `NS_GLASS_EFFECT_VIEW_STYLE_REGULAR` in
    /// `apps/desktop/src-tauri/src/platform/macos/mod.rs`. The main window
    /// takes the `SystemManaged` path, which is `setStyle:` and nothing else:
    /// the always-active pin (`setState:` / `setActive:` probing) is for the
    /// *other* Cap windows and is deliberately not reproduced here.
    const NS_GLASS_EFFECT_VIEW_STYLE_REGULAR: isize = 0;

    /// `LIQUID_GLASS_IDENTIFIER`, kept byte-identical to the Tauri app so the
    /// two view hierarchies read the same in a debugger.
    const LIQUID_GLASS_IDENTIFIER: &str = "so.cap.liquid-glass-background";

    /// `NSViewWidthSizable | NSViewHeightSizable` -- the mask the Tauri glass
    /// view gets (`setAutoresizingMask: 18usize`), which is what makes the
    /// material track the 330x395 <-> 600x660 resize animation.
    const NS_VIEW_WIDTH_HEIGHT_SIZABLE: usize = 2 | 16;

    /// Put the window's native material behind gpui's content.
    ///
    /// This is `apply_liquid_glass_background_inner(.., SystemManaged)` from
    /// `platform/macos/mod.rs` plus the vibrancy fallback
    /// `macos-window-material.ts` reaches for when the glass class is missing,
    /// translated to the one gpui window we own. gpui's `contentView` is a
    /// plain AppKit container with the Metal-backed view added as a subview
    /// (`gpui_macos::window`), exactly the shape the Tauri code assumes, so
    /// the material goes in underneath it with `NSWindowBelow`.
    ///
    /// Takes the retained [`NativeWindow`] rather than a `&Window` for the
    /// same reason [`place_overlay_panel`] does, and more so: subview
    /// insertion and content-layer mutation synchronously re-enter gpui's own
    /// window callbacks, so this must run with no gpui borrow held.
    ///
    /// Everything here is plain AppKit/Core Animation. No occlusion SPI, no
    /// CGS, no `setState:`/`setActive:` probing -- see the comment in
    /// `apply_liquid_glass_background_inner` for what that cost the shipping
    /// app.
    pub fn install_window_material(native: &NativeWindow, radius: f64) -> Option<MaterialKind> {
        use objc2::{msg_send, runtime::AnyClass, sel};
        use objc2_app_kit::{
            NSAutoresizingMaskOptions, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
            NSVisualEffectState, NSVisualEffectView, NSWindowOrderingMode,
        };
        use objc2_foundation::{MainThreadMarker, NSString};

        // Every caller is on gpui's foreground executor, which is the main
        // thread -- `NSVisualEffectView` is main-thread-only and objc2 wants
        // that proven.
        let mtm = MainThreadMarker::new()?;
        let content_view = native.0.contentView()?;

        // Clip the content view itself to the same continuous (squircle) curve
        // the material below gets. Without it the material renders a square
        // corner outside the shell's own `rounded(16.)` quad. The Tauri app
        // applies this on *both* paths for the same reason, and it is plain
        // Core Animation -- no private SPI.
        content_view.setWantsLayer(true);
        unsafe {
            let layer: *mut AnyObject = msg_send![&*content_view, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, setCornerRadius: radius];
                let _: () = msg_send![layer, setMasksToBounds: true];
                let continuous = NSString::from_str("continuous");
                let _: () = msg_send![layer, setCornerCurve: &*continuous];
            }
        }

        let bounds = content_view.bounds();

        // `NSGlassEffectView` exists only on macOS 26+; its absence is what
        // sends `macos-window-material.ts` down the vibrancy branch.
        if let Some(glass_class) = AnyClass::get("NSGlassEffectView") {
            unsafe {
                let glass: *mut AnyObject = msg_send![glass_class, alloc];
                let glass: *mut AnyObject = msg_send![glass, initWithFrame: bounds];
                if !glass.is_null() {
                    let identifier = NSString::from_str(LIQUID_GLASS_IDENTIFIER);
                    let _: () = msg_send![glass, setIdentifier: &*identifier];

                    let responds: bool =
                        msg_send![glass, respondsToSelector: sel!(setCornerRadius:)];
                    if responds {
                        let _: () = msg_send![glass, setCornerRadius: radius];
                    }

                    let _: () = msg_send![glass, setStyle: NS_GLASS_EFFECT_VIEW_STYLE_REGULAR];
                    let _: () =
                        msg_send![glass, setAutoresizingMask: NS_VIEW_WIDTH_HEIGHT_SIZABLE];
                    // The `alloc` claim is deliberately not balanced: the view
                    // lives for the life of the process (there is no teardown
                    // path here, unlike the Tauri command that can be called
                    // with `enabled: false`), and the superview's retain is
                    // what keeps it alive. Same steady state the shipping app
                    // sits in after a single apply.
                    let _: () = msg_send![
                        &*content_view,
                        addSubview: glass,
                        positioned: NSWindowOrderingMode::NSWindowBelow,
                        relativeTo: std::ptr::null_mut::<AnyObject>(),
                    ];
                    return Some(MaterialKind::LiquidGlass);
                }
            }
        }

        // The pre-macOS-26 fallback: `setEffects({ effects:
        // [Effect.WindowBackground], state: FollowsWindowActiveState, radius:
        // 16 })`. Tauri's `Effect.WindowBackground` is `NSVisualEffectMaterial`
        // `windowBackground` (12) blended behind the window; the radius is
        // already covered by the content-view squircle clip above.
        let vibrancy = unsafe { NSVisualEffectView::initWithFrame(mtm.alloc(), bounds) };
        unsafe {
            vibrancy.setMaterial(NSVisualEffectMaterial::WindowBackground);
            vibrancy.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
            vibrancy.setState(NSVisualEffectState::FollowsWindowActiveState);
            vibrancy.setAutoresizingMask(
                NSAutoresizingMaskOptions::NSViewWidthSizable
                    | NSAutoresizingMaskOptions::NSViewHeightSizable,
            );
            content_view.addSubview_positioned_relativeTo(
                &vibrancy,
                NSWindowOrderingMode::NSWindowBelow,
                None,
            );
        }
        Some(MaterialKind::Vibrancy)
    }

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

        // Same per-class, retried-from-the-same-spots lifecycle, so it rides
        // along here.
        install_frame_constraint_shim();
    }

    /// Let windows cover the menu bar.
    ///
    /// AppKit's `constrainFrameRect:toScreen:` pushes any titled window below
    /// the menu bar -- and gpui's windows all carry `NSTitledWindowMask`, even
    /// `WindowKind::PopUp` panels. A fullscreen target-select overlay set to
    /// cover the display therefore lands 33pt down (and hangs 33pt off the
    /// bottom). The Tauri app never sees this because tao's `NSWindow`
    /// subclass overrides the method to return the rect unchanged; this shim
    /// gives gpui's window classes the same override.
    fn install_frame_constraint_shim() {
        use objc2::ffi::class_addMethod;
        use objc2_foundation::NSRect;

        unsafe extern "C" fn constrain_shim(
            _this: *mut AnyObject,
            _sel: Sel,
            frame: NSRect,
            _screen: *mut AnyObject,
        ) -> NSRect {
            frame
        }

        for name in ["GPUIWindow", "GPUIPanel"] {
            let Some(class) = objc2::runtime::AnyClass::get(name) else {
                continue;
            };
            let added = unsafe {
                class_addMethod(
                    (class as *const objc2::runtime::AnyClass as *mut objc2::ffi::objc_class)
                        .cast(),
                    objc2::sel!(constrainFrameRect:toScreen:).as_ptr(),
                    Some(std::mem::transmute::<
                        unsafe extern "C" fn(*mut AnyObject, Sel, NSRect, *mut AnyObject) -> NSRect,
                        unsafe extern "C" fn(),
                    >(constrain_shim)),
                    c"{CGRect={CGPoint=dd}{CGSize=dd}}@:{CGRect={CGPoint=dd}{CGSize=dd}}@".as_ptr(),
                )
            };
            if added {
                tracing::info!("installed frame-constraint shim on {name}");
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

    /// `TELEPROMPTER_PANEL_LEVEL` in `windows.rs`, spelled there as
    /// `MAIN_PANEL_LEVEL + 1` -- i.e. 101, one step above the main window, so
    /// the script stays over the app being read from. Applied by
    /// `set_teleprompter_window_level(true)`, which the route calls once on
    /// mount; the `false` branch (back to `NSNormalWindowLevel`) has no caller
    /// and is not reproduced.
    ///
    /// A literal rather than a `CGWindowLevelForKey` lookup because that is
    /// what the constant is over there: `pub const TELEPROMPTER_PANEL_LEVEL:
    /// NSWindowLevel = MAIN_PANEL_LEVEL + 1`.
    pub fn teleprompter_level() -> isize {
        super::MAIN_WINDOW_LEVEL + 1
    }

    /// The level `windows.rs` gives every `TargetSelectOverlay`:
    /// `CGWindowLevelForKey(10) - 1`, i.e. one below the recording controls
    /// bar. Same mislabeled constant as [`recording_controls_level`] (key 10 is
    /// `kCGModalPanelWindowLevelKey`, level 8), so the shipping overlay really
    /// runs at level 7 -- above ordinary app windows, below the bar. Reproduced
    /// verbatim rather than "fixed" from over here.
    pub fn target_overlay_level() -> isize {
        recording_controls_level() - 1
    }

    /// A retained `NSWindow` that can outlive a `&Window` borrow -- what
    /// [`place_overlay_panel`] operates on.
    pub struct NativeWindow(Id<NSWindow>);

    /// The retained `NSWindow` behind a gpui window, for AppKit calls that
    /// must run *outside* any gpui update (see [`place_overlay_panel`]).
    pub fn native_window(window: &Window) -> Option<NativeWindow> {
        ns_window(window).map(NativeWindow)
    }

    /// Everything that puts a target-select overlay onto its display: frame,
    /// level, Spaces behavior, no shadow, ordered front without focus.
    ///
    /// The rect comes in as CoreGraphics coordinates -- global, top-left
    /// origin, y down, points, exactly what `scap_targets` reports for a
    /// display (`CGDisplayBounds`). Not gpui `WindowBounds`: gpui's macOS
    /// origin math is display-relative and disagrees with its own `bounds()`
    /// getter by the window height, so a window asked to cover a display lands
    /// a screenful away. AppKit's coordinates are unambiguous, so the frame is
    /// set here instead. The window frame equals the content rect for our
    /// windows -- gpui gives titlebar-less windows `NSFullSizeContentView`.
    ///
    /// Takes the retained [`NativeWindow`] rather than `&Window` because
    /// `setFrame:` and `orderFrontRegardless` synchronously re-enter gpui's
    /// own move/resize/frame callbacks, which need the App RefCell -- so the
    /// caller must run this with no gpui borrow held (a spawned task, not a
    /// window update; running it inside one logs "RefCell already borrowed"
    /// and the callbacks are dropped).
    pub fn place_overlay_panel(
        native: &NativeWindow,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        level: isize,
    ) {
        use objc2_foundation::{NSPoint, NSRect, NSSize};

        let ns_window = &native.0;
        // AppKit's global space has its origin at the bottom-left of the
        // primary display (`CGMainDisplayID`, which is what
        // `scap_targets::Display::primary` wraps); CG's is that display's
        // top-left.
        let primary_height = scap_targets::Display::primary()
            .logical_size()
            .map(|size| size.height())
            .unwrap_or(height);
        let appkit_y = primary_height - (y + height);

        ns_window.setFrame_display(
            NSRect::new(NSPoint::new(x, appkit_y), NSSize::new(width, height)),
            true,
        );
        ns_window.setLevel(level);
        unsafe {
            ns_window.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenPrimary,
            );
        }
        // `.shadow(false)` in the Tauri builder.
        ns_window.setHasShadow(false);
        unsafe { ns_window.orderFrontRegardless() };
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

    /// `NSWindow.setAlphaValue:` -- the whole of
    /// `crate::platform::set_window_opacity` in the Tauri app, which is what
    /// `set_teleprompter_window_opacity` calls with
    /// `windowOpacityPercent / 100`. The clamp is theirs too
    /// (`opacity.clamp(0.45, 1.0)`), and it is the reason the slider's floor is
    /// 45.
    ///
    /// Takes the retained handle for the [`place_overlay_panel`] reason:
    /// changing a window's alpha re-enters gpui's own window callbacks
    /// (occlusion, in particular), so it must run with no gpui borrow held.
    ///
    /// Returns the value AppKit reports back, for the probe log.
    pub fn set_window_alpha(native: &NativeWindow, alpha: f64) -> f64 {
        use objc2::msg_send;
        let alpha = alpha.clamp(0.45, 1.0);
        unsafe {
            let _: () = msg_send![&*native.0, setAlphaValue: alpha];
            native.0.alphaValue()
        }
    }

    /// `NSWindowSharingType`: `ReadOnly` (1) is the default, `None` (0) is the
    /// content-protected state.
    const NS_WINDOW_SHARING_NONE: usize = 0;
    const NS_WINDOW_SHARING_READ_ONLY: usize = 1;

    /// `window.set_content_protected(..)` -- what `apply_content_protection`
    /// does to every Cap window whose title `window_capture_excluded` matches,
    /// which for the teleprompter is unconditionally true
    /// (`if window_title == CapWindowId::Teleprompter.title() { return true }`).
    /// Tauri's implementation of `set_content_protected` on macOS is
    /// `setSharingType: None`/`ReadOnly`, so that is what this is.
    ///
    /// Returns the value AppKit reports back, for the probe log.
    pub fn set_window_capture_hidden(native: &NativeWindow, hidden: bool) -> usize {
        use objc2::msg_send;
        let sharing = if hidden {
            NS_WINDOW_SHARING_NONE
        } else {
            NS_WINDOW_SHARING_READ_ONLY
        };
        unsafe {
            let _: () = msg_send![&*native.0, setSharingType: sharing];
            msg_send![&*native.0, sharingType]
        }
    }

    /// `orderOut:` -- hide without closing, the way the Tauri main window
    /// hides while the recording controls bar is up. Takes the retained
    /// handle for the same reason [`place_overlay_panel`] does: ordering a
    /// window in or out synchronously re-enters gpui's window callbacks, so
    /// it must run with no gpui borrow held.
    pub fn hide_native(native: &NativeWindow) {
        native.0.orderOut(None);
    }

    /// Reverse of [`hide_native`] -- `makeKeyAndOrderFront:`.
    pub fn show_native(native: &NativeWindow) {
        native.0.makeKeyAndOrderFront(None);
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

    use super::{MaterialKind, PanelBehavior};

    pub fn install_window_material(_native: &NativeWindow, _radius: f64) -> Option<MaterialKind> {
        None
    }
    pub fn recording_controls_level() -> isize {
        0
    }
    pub fn target_overlay_level() -> isize {
        0
    }
    pub fn teleprompter_level() -> isize {
        0
    }
    pub struct NativeWindow;
    pub fn set_window_alpha(_native: &NativeWindow, _alpha: f64) -> f64 {
        1.
    }
    pub fn set_window_capture_hidden(_native: &NativeWindow, _hidden: bool) -> usize {
        0
    }
    pub fn native_window(_window: &Window) -> Option<NativeWindow> {
        None
    }
    pub fn place_overlay_panel(
        _native: &NativeWindow,
        _x: f64,
        _y: f64,
        _width: f64,
        _height: f64,
        _level: isize,
    ) {
    }
    pub fn install_occlusion_shim() {}
    pub fn kick_display_link(_window: &Window) {}
    pub fn apply_panel_behavior(_window: &Window, _behavior: PanelBehavior) {}
    pub fn hide_native(_native: &NativeWindow) {}
    pub fn show_native(_native: &NativeWindow) {}
    pub fn show_window_without_focus(_window: &Window) {}
    pub fn window_number(_window: &Window) -> Option<isize> {
        None
    }
}

#[cfg(not(target_os = "macos"))]
pub use stub::*;
