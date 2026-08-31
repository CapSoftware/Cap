//! Native window treatment gpui does not expose.
//!
//! The Tauri app gives its windows their panel behavior in
//! `apps/desktop/src-tauri/src/windows.rs`: converted to NSPanel via
//! `tauri_nspanel`, raised to a specific window level, joined to all Spaces.
//! gpui exposes none of that, but its `Window` implements
//! `raw_window_handle::HasWindowHandle`, and on macOS the AppKit handle's
//! `ns_view` reaches the `NSWindow`, where the same AppKit calls apply.
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
/// `tauri::Window::set_theme`: `None` follows the OS, Light/Dark force
/// `NSAppearanceNameAqua` / `DarkAqua` on that window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForcedAppearance {
    System,
    Light,
    Dark,
}

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

#[cfg(any(target_os = "macos", test))]
struct NativeQuitRequests {
    sender: flume::Sender<()>,
    permitted: std::sync::atomic::AtomicBool,
}

#[cfg(any(target_os = "macos", test))]
impl NativeQuitRequests {
    fn new() -> (Self, flume::Receiver<()>) {
        let (sender, receiver) = flume::bounded(1);
        (
            Self {
                sender,
                permitted: std::sync::atomic::AtomicBool::new(false),
            },
            receiver,
        )
    }

    fn permit_exit(&self) {
        self.permitted
            .store(true, std::sync::atomic::Ordering::Release);
    }

    fn request(&self) -> bool {
        if self
            .permitted
            .swap(false, std::sync::atomic::Ordering::AcqRel)
        {
            return true;
        }
        let _ = self.sender.try_send(());
        false
    }
}

pub fn active_material(cx: &gpui::App) -> Option<MaterialKind> {
    cx.try_global::<WindowMaterial>()
        .and_then(|material| material.0)
}

#[cfg(any(not(target_os = "macos"), test))]
fn confirmation_accepted(result: rfd::MessageDialogResult, accept: &str) -> bool {
    match result {
        rfd::MessageDialogResult::Ok => true,
        rfd::MessageDialogResult::Custom(label) => label == accept,
        _ => false,
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PanelBehavior {
    pub level: isize,
    /// `CanJoinAllSpaces | FullScreenAuxiliary`, so the window follows Spaces
    /// and can sit over another app's fullscreen session.
    pub join_all_spaces: bool,
    /// Borderless NSWindows get a system shadow; the recording controls bar is
    /// drawn shadowless (`.shadow(false)` in the Tauri builder).
    pub shadow: bool,
}

#[cfg(target_os = "macos")]
pub use mac::*;

#[cfg(target_os = "macos")]
mod macos_occlusion;

#[cfg(target_os = "macos")]
mod mac {
    use gpui::Window;
    use objc2::rc::Id;
    use objc2::runtime::{AnyObject, Sel};
    use objc2_app_kit::{NSView, NSWindow, NSWindowCollectionBehavior};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    use super::{ForcedAppearance, MaterialKind, PanelBehavior};

    static NATIVE_QUIT_REQUESTS: std::sync::OnceLock<super::NativeQuitRequests> =
        std::sync::OnceLock::new();

    unsafe extern "C-unwind" fn application_should_terminate(
        _: &AnyObject,
        _: Sel,
        _: *mut AnyObject,
    ) -> usize {
        usize::from(
            NATIVE_QUIT_REQUESTS
                .get()
                .is_some_and(|requests| requests.request()),
        )
    }

    pub fn install_native_quit_handler() -> Result<flume::Receiver<()>, String> {
        use objc2::{class, ffi, msg_send, runtime::Imp, sel};
        use objc2_foundation::MainThreadMarker;

        let _main_thread =
            MainThreadMarker::new().ok_or("Native Quit must be installed on the main thread")?;
        unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let app = app.as_ref().ok_or("NSApplication is unavailable")?;
            let delegate: *mut AnyObject = msg_send![app, delegate];
            let delegate = delegate
                .as_ref()
                .ok_or("Application delegate is unavailable")?;
            let delegate_class = delegate.class();
            if delegate_class.name() != "GPUIApplicationDelegate" {
                return Err("Native Quit requires the owned GPUI application delegate".into());
            }
            let selector = sel!(applicationShouldTerminate:);
            if delegate_class.instance_method(selector).is_some() {
                return Err("Application delegate already has a native Quit handler".into());
            }
            let (requests, receiver) = super::NativeQuitRequests::new();
            NATIVE_QUIT_REQUESTS
                .set(requests)
                .map_err(|_| "Native Quit request receiver was already installed")?;
            let implementation = std::mem::transmute::<
                unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize,
                Imp,
            >(application_should_terminate);
            if !objc2::runtime::Bool::from_raw(ffi::class_addMethod(
                delegate_class as *const _ as *mut _,
                selector.as_ptr(),
                Some(implementation),
                c"Q@:@".as_ptr(),
            ))
            .as_bool()
            {
                return Err("Could not install the native Quit handler".into());
            }
            Ok(receiver)
        }
    }

    pub fn permit_native_quit() {
        if let Some(requests) = NATIVE_QUIT_REQUESTS.get() {
            requests.permit_exit();
        }
    }

    pub fn apply_window_theme(window: &Window, appearance: ForcedAppearance) {
        use objc2_app_kit::{
            NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
        };

        let Some(ns) = ns_window(window) else {
            return;
        };
        let named = match appearance {
            ForcedAppearance::System => None,
            ForcedAppearance::Light => {
                NSAppearance::appearanceNamed(unsafe { NSAppearanceNameAqua })
            }
            ForcedAppearance::Dark => {
                NSAppearance::appearanceNamed(unsafe { NSAppearanceNameDarkAqua })
            }
        };
        unsafe {
            NSAppearanceCustomization::setAppearance(&*ns, named.as_deref());
        }
    }

    pub fn window_is_dark(window: &Window) -> Option<bool> {
        use objc2_app_kit::{
            NSAppearanceCustomization, NSAppearanceNameAccessibilityHighContrastDarkAqua,
            NSAppearanceNameAccessibilityHighContrastVibrantDark, NSAppearanceNameDarkAqua,
            NSAppearanceNameVibrantDark,
        };

        let ns = ns_window(window)?;
        let effective = unsafe { NSAppearanceCustomization::effectiveAppearance(&*ns) };
        let name = unsafe { effective.name() };
        Some(unsafe {
            name.isEqualToString(NSAppearanceNameDarkAqua)
                || name.isEqualToString(NSAppearanceNameVibrantDark)
                || name.isEqualToString(NSAppearanceNameAccessibilityHighContrastDarkAqua)
                || name.isEqualToString(NSAppearanceNameAccessibilityHighContrastVibrantDark)
        })
    }

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

        // Clip the content view to the window's corner radius so the material
        // below cannot paint a square corner outside the shell's own rounded
        // quad. The curve must stay CIRCULAR (the layer default): gpui quads
        // round with circular arcs, and a `continuous` (squircle) clip bulges
        // outside a circular arc of the same radius along the corner
        // diagonals -- the material showed through that crescent as the
        // settings window's white bleed at every corner in dark mode (worst
        // at the bottom, where nothing overlaps it). Radius must match what
        // the window's root element draws, not what looks close.
        content_view.setWantsLayer(true);
        let set_clip_radius = |radius: f64| unsafe {
            let layer: *mut AnyObject = msg_send![&*content_view, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, setCornerRadius: radius];
                let _: () = msg_send![layer, setMasksToBounds: true];
            }
        };
        set_clip_radius(16.0);

        let bounds = content_view.bounds();

        // `CAP_GPUI_MATERIAL=none|vibrancy`: bisect hooks for the chrome
        // screenshots -- `none` keeps only the squircle clip (no material
        // view), `vibrancy` skips the glass branch and takes the pre-26
        // fallback. Unset means the real recipe.
        let material_override = std::env::var("CAP_GPUI_MATERIAL").ok();
        if material_override.as_deref() == Some("none") {
            return None;
        }

        // `NSGlassEffectView` exists only on macOS 26+; its absence is what
        // sends `macos-window-material.ts` down the vibrancy branch.
        if material_override.as_deref() != Some("vibrancy")
            && let Some(glass_class) = AnyClass::get("NSGlassEffectView")
        {
            unsafe {
                let glass: *mut AnyObject = msg_send![glass_class, alloc];
                let glass: *mut AnyObject = msg_send![glass, initWithFrame: bounds];
                if let Some(glass) = Id::from_raw(glass) {
                    set_clip_radius(radius);
                    let identifier = NSString::from_str(LIQUID_GLASS_IDENTIFIER);
                    let _: () = msg_send![&*glass, setIdentifier: &*identifier];

                    let responds: bool =
                        msg_send![&*glass, respondsToSelector: sel!(setCornerRadius:)];
                    if responds {
                        let _: () = msg_send![&*glass, setCornerRadius: radius];
                    }

                    let _: () = msg_send![&*glass, setStyle: NS_GLASS_EFFECT_VIEW_STYLE_REGULAR];
                    let _: () =
                        msg_send![&*glass, setAutoresizingMask: NS_VIEW_WIDTH_HEIGHT_SIZABLE];
                    let _: () = msg_send![
                        &*content_view,
                        addSubview: &*glass,
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
        super::macos_occlusion::install();

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
            if objc2::runtime::Bool::from_raw(added).as_bool() {
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

    /// Re-assert the buttonless style mask the main window was created with:
    /// `NSTitledWindowMask | NSFullSizeContentViewWindowMask` (gpui's
    /// `titlebar: None`). During the recording flow -- after the hidden main
    /// window's `orderOut:` and the in-process ScreenCaptureKit start -- macOS
    /// 26 adds `NSMiniaturizableWindowMask` to the hidden window on its own
    /// (no app or gpui code writes the mask; verified with a breakpoint on
    /// `setStyleMask:` and a mask poll), which materializes all three standard
    /// titlebar buttons on top of the hand-drawn lights. Setting the mask back
    /// tears the buttons down. Same borrow rule as [`show_native`]: call from
    /// a task, never inside a gpui update.
    pub fn restore_borderless_style(native: &NativeWindow) {
        use objc2::msg_send;
        const TITLED: usize = 1 << 0;
        const FULL_SIZE_CONTENT_VIEW: usize = 1 << 15;
        let want = TITLED | FULL_SIZE_CONTENT_VIEW;
        unsafe {
            let mask: usize = msg_send![&*native.0, styleMask];
            if mask != want {
                tracing::info!(mask, "clearing foreign style-mask bits on the main window");
                let _: () = msg_send![&*native.0, setStyleMask: want];
            }
        }
    }

    pub fn remove_popup_window_chrome(native: &NativeWindow) {
        use objc2::msg_send;

        const TITLED: usize = 1 << 0;

        unsafe {
            let mask: usize = msg_send![&*native.0, styleMask];
            let borderless = mask & !TITLED;
            if mask != borderless {
                let _: () = msg_send![&*native.0, setStyleMask: borderless];
            }
        }
    }

    /// Dev probe (`CAP_GPUI_DEBUG_LIGHTS=1`): the window's style mask plus
    /// which standard titlebar buttons AppKit has materialized. Read-only
    /// `msg_send`s, safe inside a gpui update.
    pub fn debug_titlebar_state(window: &Window) -> Option<String> {
        use objc2::msg_send;
        let ns = ns_window(window)?;
        unsafe {
            let mask: usize = msg_send![&*ns, styleMask];
            let close: *mut AnyObject = msg_send![&*ns, standardWindowButton: 0usize];
            let min: *mut AnyObject = msg_send![&*ns, standardWindowButton: 1usize];
            let zoom: *mut AnyObject = msg_send![&*ns, standardWindowButton: 2usize];
            let visible: bool = msg_send![&*ns, isVisible];
            Some(format!(
                "mask={mask:#x} visible={visible} close={} min={} zoom={}",
                !close.is_null(),
                !min.is_null(),
                !zoom.is_null()
            ))
        }
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
        apply_fullscreen_overlay_behavior(ns_window);
        // `.shadow(false)` in the Tauri builder.
        ns_window.setHasShadow(false);
        unsafe { ns_window.orderFrontRegardless() };
    }

    /// The window's raw AppKit frame (bottom-left origin). The dev-restore
    /// snapshot stores frames in AppKit coordinates and hands them straight
    /// back to [`set_window_frame`], so the roundtrip needs no flip math and
    /// cannot drift. A plain getter, safe inside a gpui update.
    pub fn window_frame(native: &NativeWindow) -> (f64, f64, f64, f64) {
        let frame = native.0.frame();
        (
            frame.origin.x,
            frame.origin.y,
            frame.size.width,
            frame.size.height,
        )
    }

    /// Counterpart of [`window_frame`]: `setFrame:display:` with the captured
    /// AppKit rect, no coordinate conversion. Same borrow rule as
    /// [`place_overlay_panel`] -- `setFrame:` synchronously re-enters gpui's
    /// own window callbacks, so call from a task, never inside an update.
    pub fn set_window_frame(native: &NativeWindow, x: f64, y: f64, width: f64, height: f64) {
        use objc2_foundation::{NSPoint, NSRect, NSSize};

        native.0.setFrame_display(
            NSRect::new(NSPoint::new(x, y), NSSize::new(width, height)),
            true,
        );
    }

    /// Whether a saved AppKit frame still lands on a connected display.
    ///
    /// A frame captured while an external monitor was attached keeps that
    /// monitor's coordinates after it is unplugged, and `setFrame:` will
    /// happily place a window at x=2519 on a 1512pt-wide laptop screen: the
    /// window is then live, ordered front and completely invisible, which
    /// reads as "the app opens and disappears". Raw messages rather than
    /// `objc2_app_kit::NSScreen` for the same reason as `mainScreen` below --
    /// the typed binding needs the `NSScreen` feature.
    pub fn frame_is_on_screen(x: f64, y: f64, width: f64, height: f64) -> bool {
        use objc2::{class, msg_send, runtime::AnyObject};
        use objc2_foundation::NSRect;

        // Enough of the window on one screen to grab and move it.
        const MIN_VISIBLE: f64 = 80.0;

        unsafe {
            let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
            if screens.is_null() {
                return true;
            }
            let enumerator: *mut AnyObject = msg_send![screens, objectEnumerator];
            if enumerator.is_null() {
                return true;
            }
            loop {
                let screen: *mut AnyObject = msg_send![enumerator, nextObject];
                if screen.is_null() {
                    break;
                }
                let bounds: NSRect = msg_send![screen, frame];
                let overlap_x =
                    (x + width).min(bounds.origin.x + bounds.size.width) - x.max(bounds.origin.x);
                let overlap_y =
                    (y + height).min(bounds.origin.y + bounds.size.height) - y.max(bounds.origin.y);
                if overlap_x >= MIN_VISIBLE.min(width) && overlap_y >= MIN_VISIBLE.min(height) {
                    return true;
                }
            }
        }
        false
    }

    /// `orderFrontRegardless` on the retained handle: bring a restored window
    /// forward without activating the app -- the dev loop relaunches on every
    /// rebuild and must not steal focus from whatever the user is typing in.
    /// Same task-only rule as every other ordering call here.
    pub fn order_front_native(native: &NativeWindow) {
        unsafe { native.0.orderFrontRegardless() };
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
            apply_fullscreen_overlay_behavior(&ns_window);
        }
        ns_window.setHasShadow(behavior.shadow);
    }

    /// Stay visible on every Space, including another app's fullscreen.
    ///
    /// `FullScreenPrimary` is what a document window uses to *become*
    /// fullscreen. On a normal `NSWindow` it also keeps the window out of
    /// foreign fullscreen Spaces. `FullScreenAuxiliary` is the flag AppKit
    /// documents for floating over those Spaces, and it is what
    /// tauri-nspanel's fullscreen example sets after the panel swizzle.
    fn apply_fullscreen_overlay_behavior(ns_window: &NSWindow) {
        // Changing an initialized NSWindow's class breaks AppKit's KVO teardown.
        // Callers that need a panel must create it as Floating or PopUp.
        unsafe {
            ns_window.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary,
            );
            ns_window.setHidesOnDeactivate(false);
            let can_float: bool = objc2::msg_send![
                ns_window,
                respondsToSelector: objc2::sel!(setFloatingPanel:)
            ];
            if can_float {
                let _: () = objc2::msg_send![ns_window, setFloatingPanel: true];
            }
        }
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

    /// Close the window the way the red traffic light does: ask the
    /// delegate's `windowShouldClose:` (gpui's `on_window_should_close`,
    /// where every window's close bookkeeping lives), then `close`.
    ///
    /// NOT `performClose:`. That is the obvious spelling and it silently
    /// refuses here -- observed on macOS 26 with the close button present,
    /// enabled, and the delegate wired (the ⌘W action logged, `performClose:`
    /// returned, the window stayed). Its close-button simulation is the only
    /// part the contract loses, so the two real steps are spelled out
    /// directly. Same retained-handle discipline as [`hide_native`].
    /// The dock icon. An unbundled dev binary carries no Info.plist icon, so
    /// one is set at runtime with `setApplicationIconImage:`.
    ///
    /// The shape matters more than the bytes on macOS 26: the system
    /// re-renders every *bundle* icon onto its standard squircle plate (the
    /// legacy-icon treatment), which is what the shipping Cap.app's dock tile
    /// shows -- but a raw `setApplicationIconImage:` bypasses that pipeline,
    /// so the classic `icon.png` renders with its own pre-26 rounded-rect
    /// shape and looks visibly different next to the original. NSWorkspace's
    /// `iconForFile:` hands back the icon *as the system presents it*,
    /// treatment included, so the installed Cap.app's is used when it exists
    /// and the raw asset only as a fallback. A future .app bundle with its
    /// own (Icon Composer) icon supersedes all of this.
    pub fn set_dock_icon(fallback_png: &[u8]) {
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;
        unsafe {
            let mut image: Option<Id<AnyObject>> = None;

            let cap_app = NSString::from_str("/Applications/Cap.app");
            let exists: bool = {
                let manager: *mut AnyObject = msg_send![class!(NSFileManager), defaultManager];
                !manager.is_null() && msg_send![manager, fileExistsAtPath: &*cap_app]
            };
            if exists {
                let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
                if !workspace.is_null() {
                    let raw: *mut AnyObject = msg_send![workspace, iconForFile: &*cap_app];
                    // `iconForFile:` is autoreleased; retain for the setter.
                    image = Id::retain(raw);
                    if let Some(image) = &image {
                        // The workspace icon's nominal size is small (32pt);
                        // the reps go up to 1024. Ask for dock resolution.
                        let _: () = msg_send![
                            &**image,
                            setSize: objc2_foundation::NSSize::new(512., 512.)
                        ];
                    }
                }
            }

            if image.is_none() {
                let data: *mut AnyObject = msg_send![
                    class!(NSData),
                    dataWithBytes: fallback_png.as_ptr().cast::<std::ffi::c_void>(),
                    length: fallback_png.len(),
                ];
                if !data.is_null() {
                    let alloc: *mut AnyObject = msg_send![class!(NSImage), alloc];
                    let raw: *mut AnyObject = msg_send![alloc, initWithData: data];
                    image = Id::from_raw(raw);
                }
            }

            let Some(image) = image else { return };
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if !app.is_null() {
                let _: () = msg_send![app, setApplicationIconImage: &*image];
            }
            tracing::info!(from_installed_app = exists, "dock icon set");
        }
    }

    pub fn close_native(native: &NativeWindow) {
        use objc2::{msg_send, sel};
        unsafe {
            let delegate: *mut AnyObject = msg_send![&*native.0, delegate];
            let should_close: bool = if delegate.is_null() {
                true
            } else {
                let responds: bool =
                    msg_send![delegate, respondsToSelector: sel!(windowShouldClose:)];
                if responds {
                    msg_send![delegate, windowShouldClose: &*native.0]
                } else {
                    true
                }
            };
            tracing::info!(should_close, "close_native");
            if should_close {
                let _: () = msg_send![&*native.0, close];
            }
        }
    }

    // -- The global Escape hotkey (Carbon) -------------------------------

    /// `tauri_plugin_global_shortcut`'s macOS backend is Carbon
    /// `RegisterEventHotKey`, and `target_select_overlay.rs:595-617` registers
    /// a plain `Escape` while the target-select overlays are up (and only
    /// then -- a permanently-registered global Escape would swallow the key
    /// system-wide). The overlays need it because the main window hides while
    /// the picker is up, which usually leaves the app with no key window, and
    /// the overlays themselves are non-activating panels: an ordinary key
    /// handler has nothing to be delivered to.
    ///
    /// The Carbon handler fires on the main thread inside the event
    /// dispatcher, not inside a gpui update -- but the established discipline
    /// applies anyway: it posts into a channel and a foreground task drains it
    /// with a clean borrow (the tray's shape).
    mod escape_hotkey {
        use std::cell::{Cell, RefCell};
        use std::ffi::c_void;

        type OsStatus = i32;
        #[repr(C)]
        struct EventTypeSpec {
            event_class: u32,
            event_kind: u32,
        }
        #[repr(C)]
        #[derive(Clone, Copy)]
        struct EventHotKeyId {
            signature: u32,
            id: u32,
        }

        /// `'keyb'` / `kEventHotKeyPressed` / `kVK_Escape` / `'CapG'`.
        const K_EVENT_CLASS_KEYBOARD: u32 = 0x6b65_7962;
        const K_EVENT_HOT_KEY_PRESSED: u32 = 5;
        const KVK_ESCAPE: u32 = 53;
        const SIGNATURE: u32 = 0x4361_7047;

        #[link(name = "Carbon", kind = "framework")]
        unsafe extern "C" {
            fn GetEventDispatcherTarget() -> *mut c_void;
            fn InstallEventHandler(
                target: *mut c_void,
                handler: extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> OsStatus,
                num_types: usize,
                types: *const EventTypeSpec,
                user_data: *mut c_void,
                out_ref: *mut *mut c_void,
            ) -> OsStatus;
            fn RegisterEventHotKey(
                key_code: u32,
                modifiers: u32,
                id: EventHotKeyId,
                target: *mut c_void,
                options: u32,
                out_ref: *mut *mut c_void,
            ) -> OsStatus;
            fn UnregisterEventHotKey(hotkey: *mut c_void) -> OsStatus;
        }

        thread_local! {
            static ESCAPE_TX: RefCell<Option<flume::Sender<()>>> = const { RefCell::new(None) };
            static HOTKEY: Cell<*mut c_void> = const { Cell::new(std::ptr::null_mut()) };
            static HANDLER_INSTALLED: Cell<bool> = const { Cell::new(false) };
        }

        extern "C" fn escape_pressed(
            _call_ref: *mut c_void,
            _event: *mut c_void,
            _user_data: *mut c_void,
        ) -> OsStatus {
            ESCAPE_TX.with(|tx| {
                if let Some(sender) = tx.borrow().as_ref() {
                    let _ = sender.send(());
                }
            });
            0
        }

        /// The press stream. First call wires the channel; the handler itself
        /// is installed lazily by [`register`] so an app that never opens a
        /// picker never touches Carbon.
        pub fn events() -> flume::Receiver<()> {
            let (tx, rx) = flume::unbounded();
            ESCAPE_TX.with(|slot| *slot.borrow_mut() = Some(tx));
            rx
        }

        /// Register the global Escape. Idempotent; main thread only (every
        /// caller is a window-orchestration function, which run there).
        pub fn register() {
            if !HOTKEY.with(|slot| slot.get().is_null()) {
                return;
            }
            unsafe {
                let target = GetEventDispatcherTarget();
                if !HANDLER_INSTALLED.with(Cell::get) {
                    let spec = EventTypeSpec {
                        event_class: K_EVENT_CLASS_KEYBOARD,
                        event_kind: K_EVENT_HOT_KEY_PRESSED,
                    };
                    let mut handler_ref = std::ptr::null_mut();
                    let status = InstallEventHandler(
                        target,
                        escape_pressed,
                        1,
                        &spec,
                        std::ptr::null_mut(),
                        &mut handler_ref,
                    );
                    if status != 0 {
                        tracing::warn!(status, "InstallEventHandler failed; no global Escape");
                        return;
                    }
                    HANDLER_INSTALLED.with(|slot| slot.set(true));
                }
                let id = EventHotKeyId {
                    signature: SIGNATURE,
                    id: 1,
                };
                let mut hotkey = std::ptr::null_mut();
                let status = RegisterEventHotKey(
                    KVK_ESCAPE,
                    0,
                    id,
                    GetEventDispatcherTarget(),
                    0,
                    &mut hotkey,
                );
                if status != 0 {
                    tracing::warn!(status, "RegisterEventHotKey(Escape) failed");
                    return;
                }
                HOTKEY.with(|slot| slot.set(hotkey));
                tracing::info!("global Escape hotkey registered");
            }
        }

        /// Unregister. Idempotent; Escape goes back to the system.
        pub fn unregister() {
            let hotkey = HOTKEY.with(|slot| slot.replace(std::ptr::null_mut()));
            if hotkey.is_null() {
                return;
            }
            unsafe {
                let _ = UnregisterEventHotKey(hotkey);
            }
            tracing::info!("global Escape hotkey unregistered");
        }
    }

    pub fn escape_hotkey_events() -> flume::Receiver<()> {
        escape_hotkey::events()
    }
    pub fn register_escape_hotkey() {
        escape_hotkey::register();
    }
    pub fn unregister_escape_hotkey() {
        escape_hotkey::unregister();
    }

    /// `performMiniaturize:` -- the selector muda gives the Window menu's
    /// Minimize item. Same retained-handle discipline as [`hide_native`]:
    /// miniaturizing re-enters gpui's own window callbacks.
    pub fn minimize_native(native: &NativeWindow) {
        use objc2::msg_send;
        unsafe {
            let _: () =
                msg_send![&*native.0, performMiniaturize: std::ptr::null_mut::<AnyObject>()];
        }
    }

    /// `performZoom:` -- muda's Window > Zoom.
    pub fn zoom_native(native: &NativeWindow) {
        use objc2::msg_send;
        unsafe {
            let _: () = msg_send![&*native.0, performZoom: std::ptr::null_mut::<AnyObject>()];
        }
    }

    /// `toggleFullScreen:` -- muda's View > (Enter|Exit) Full Screen.
    pub fn toggle_fullscreen_native(native: &NativeWindow) {
        use objc2::msg_send;
        unsafe {
            let _: () = msg_send![&*native.0, toggleFullScreen: std::ptr::null_mut::<AnyObject>()];
        }
    }

    /// `window.is_visible()` -- what `sync_macos_dock_visibility` asks every
    /// window. A plain getter, so it is safe inside a gpui update.
    pub fn window_is_visible(window: &Window) -> bool {
        ns_window(window).is_some_and(|ns| ns.isVisible())
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

    // -- The open panel ------------------------------------------------------

    /// `<input type="file" accept="image/...">`, which on macOS is an
    /// `NSOpenPanel` (`ConfigSidebar.tsx:2508-2542`).
    ///
    /// `runModal` spins AppKit's own modal run loop, so like every other call
    /// here it must be made with no gpui borrow held -- from a spawned task,
    /// never from inside an update.
    pub fn open_audio_panel() -> Option<std::path::PathBuf> {
        open_file_panel(&["mp3", "wav", "m4a", "ogg", "flac", "aac"])
    }

    pub fn open_image_panel(extensions: &[&str]) -> Option<std::path::PathBuf> {
        open_file_panel(extensions)
    }

    pub fn save_file_panel(suggested: &str, extensions: &[&str]) -> Option<std::path::PathBuf> {
        use objc2::{class, msg_send};
        use objc2_foundation::{NSArray, NSString};

        unsafe {
            let panel: *mut AnyObject = msg_send![class!(NSSavePanel), savePanel];
            if panel.is_null() {
                return None;
            }
            let _: () = msg_send![panel, setCanCreateDirectories: true];
            let _: () = msg_send![panel, setNameFieldStringValue: &*NSString::from_str(suggested)];
            if !extensions.is_empty() {
                let types: Vec<Id<NSString>> = extensions
                    .iter()
                    .map(|extension| NSString::from_str(extension))
                    .collect();
                let types = NSArray::from_vec(types);
                let _: () = msg_send![panel, setAllowedFileTypes: &*types];
            }
            let response: isize = msg_send![panel, runModal];
            if response != 1 {
                return None;
            }
            let url: *mut AnyObject = msg_send![panel, URL];
            if url.is_null() {
                return None;
            }
            let path: *mut NSString = msg_send![url, path];
            if path.is_null() {
                return None;
            }
            Some(std::path::PathBuf::from((*path).to_string()))
        }
    }

    pub fn copy_file_to_clipboard(path: &std::path::Path) -> Result<(), String> {
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;

        unsafe {
            let pasteboard: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
            if pasteboard.is_null() {
                return Err("Clipboard unavailable".into());
            }
            let _: isize = msg_send![pasteboard, clearContents];
            let url_class = class!(NSURL);
            let ns_path = NSString::from_str(&path.to_string_lossy());
            let url: *mut AnyObject = msg_send![url_class, fileURLWithPath: &*ns_path];
            if url.is_null() {
                return Err("Failed to build file URL".into());
            }
            let objects: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: url];
            let ok: bool = msg_send![pasteboard, writeObjects: objects];
            if ok {
                Ok(())
            } else {
                Err("Failed to copy file to clipboard".into())
            }
        }
    }

    pub fn copy_image_to_clipboard(path: &std::path::Path) -> Result<(), String> {
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;

        unsafe {
            let pasteboard: *mut AnyObject = msg_send![class!(NSPasteboard), generalPasteboard];
            if pasteboard.is_null() {
                return Err("Clipboard unavailable".into());
            }
            let _: isize = msg_send![pasteboard, clearContents];
            let ns_path = NSString::from_str(&path.to_string_lossy());
            let image: *mut AnyObject = msg_send![class!(NSImage), alloc];
            let image: *mut AnyObject = msg_send![image, initWithContentsOfFile: &*ns_path];
            if image.is_null() {
                return Err("Failed to load image".into());
            }
            let objects: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: image];
            let ok: bool = msg_send![pasteboard, writeObjects: objects];
            if ok {
                Ok(())
            } else {
                Err("Failed to copy image to clipboard".into())
            }
        }
    }

    fn open_file_panel(extensions: &[&str]) -> Option<std::path::PathBuf> {
        use objc2::{class, msg_send};
        use objc2_foundation::{NSArray, NSString};

        unsafe {
            let panel: *mut AnyObject = msg_send![class!(NSOpenPanel), openPanel];
            if panel.is_null() {
                return None;
            }
            let _: () = msg_send![panel, setCanChooseFiles: true];
            let _: () = msg_send![panel, setCanChooseDirectories: false];
            let _: () = msg_send![panel, setAllowsMultipleSelection: false];

            let types: Vec<Id<NSString>> = extensions
                .iter()
                .map(|extension| NSString::from_str(extension))
                .collect();
            let types = NSArray::from_vec(types);
            let _: () = msg_send![panel, setAllowedFileTypes: &*types];

            // `NSModalResponseOK`.
            let response: isize = msg_send![panel, runModal];
            if response != 1 {
                return None;
            }
            let url: *mut AnyObject = msg_send![panel, URL];
            if url.is_null() {
                return None;
            }
            let path: *mut NSString = msg_send![url, path];
            if path.is_null() {
                return None;
            }
            Some(std::path::PathBuf::from((*path).to_string()))
        }
    }

    // -- Confirmation alerts -------------------------------------------------

    /// `@tauri-apps/plugin-dialog`'s `ask()` / `confirm()`, which on macOS are
    /// an `NSAlert` with two buttons: `messageText` is the dialog's title
    /// (defaulting to the app name for `ask`), `informativeText` the question,
    /// and the return is "was the *first* button pressed" --
    /// `NSAlertFirstButtonReturn`.
    ///
    /// `runModal` spins AppKit's own modal run loop, which re-enters gpui's
    /// window callbacks for as long as the alert is up. It must therefore be
    /// called with no gpui borrow held -- from a spawned task, never inside an
    /// update ([`place_overlay_panel`]'s rule). gpui's foreground executor is
    /// the main thread, which is where AppKit requires this to run, so a
    /// `cx.spawn` task is both the correct thread and the correct borrow state.
    pub fn confirm_dialog(
        title: &str,
        message: &str,
        accept: &str,
        cancel: &str,
        warning: bool,
    ) -> bool {
        use objc2::{class, msg_send, msg_send_id};
        use objc2_foundation::NSString;

        /// `NSAlertStyle`: `Warning = 0`, `Informational = 1`. `NSUInteger`,
        /// not `NSInteger` -- objc2's message-send verification rejects the
        /// signed spelling at runtime ("expected argument at index 0 to have
        /// type code 'Q', but found 'q'"), which is a panic, not a warning.
        const NS_ALERT_STYLE_WARNING: usize = 0;
        const NS_ALERT_STYLE_INFORMATIONAL: usize = 1;
        /// `NSAlertFirstButtonReturn`. This one *is* an `NSInteger`.
        const NS_ALERT_FIRST_BUTTON_RETURN: isize = 1000;

        unsafe {
            let alert: Id<AnyObject> = msg_send_id![class!(NSAlert), new];
            let _: () = msg_send![&*alert, setMessageText: &*NSString::from_str(title)];
            let _: () = msg_send![&*alert, setInformativeText: &*NSString::from_str(message)];
            let _: () = msg_send![
                &*alert,
                setAlertStyle: if warning {
                    NS_ALERT_STYLE_WARNING
                } else {
                    NS_ALERT_STYLE_INFORMATIONAL
                }
            ];
            // Order matters: the first button added is the default one, and
            // the one `NSAlertFirstButtonReturn` reports.
            let _: *mut AnyObject =
                msg_send![&*alert, addButtonWithTitle: &*NSString::from_str(accept)];
            let _: *mut AnyObject =
                msg_send![&*alert, addButtonWithTitle: &*NSString::from_str(cancel)];
            let response: isize = msg_send![&*alert, runModal];
            response == NS_ALERT_FIRST_BUTTON_RETURN
        }
    }

    pub fn alert_dialog(title: &str, message: &str) {
        use objc2::{class, msg_send, msg_send_id};
        use objc2_foundation::NSString;

        const NS_ALERT_STYLE_INFORMATIONAL: usize = 1;

        unsafe {
            let alert: Id<AnyObject> = msg_send_id![class!(NSAlert), new];
            let _: () = msg_send![&*alert, setMessageText: &*NSString::from_str(title)];
            let _: () = msg_send![&*alert, setInformativeText: &*NSString::from_str(message)];
            let _: () = msg_send![&*alert, setAlertStyle: NS_ALERT_STYLE_INFORMATIONAL];
            let _: *mut AnyObject =
                msg_send![&*alert, addButtonWithTitle: &*NSString::from_str("OK")];
            let _: isize = msg_send![&*alert, runModal];
        }
    }

    pub fn activate_app() {
        use objc2::{class, msg_send};

        unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if !app.is_null() {
                let _: () = msg_send![&*app, activateIgnoringOtherApps: true];
            }
        }
    }

    /// `commands.focusWindow(id)` -- the macOS body of the `focus_window`
    /// command (`src-tauri/src/target_select_overlay.rs:377-399`): the picked
    /// window's owning pid, its `NSRunningApplication`, and
    /// `activateWithOptions:ActivateIgnoringOtherApps`. Activating the *app*
    /// is all the Tauri command does on this platform -- no un-minimize, no
    /// per-window raise (that half is the `cfg(windows)` arm, which this app
    /// has no counterpart for yet).
    ///
    /// Spelled with `msg_send!` rather than `objc2_app_kit::NSRunningApplication`
    /// on purpose: the typed binding needs the `NSRunningApplication` feature
    /// on `objc2-app-kit`, and that crate version is shared with
    /// `accesskit_macos` -> `gpui_macos` -> `gpui`, so widening its feature set
    /// rebuilds the whole gpui stack for one selector.
    ///
    /// Called from a background task, never inside a gpui update: the Tauri
    /// command runs on an async command thread, and cross-process activation
    /// must not happen with the App RefCell held.
    pub fn focus_capture_target_window(id: &scap_targets::WindowId) -> bool {
        use objc2::{class, msg_send};

        /// `NSApplicationActivationOptions::ActivateIgnoringOtherApps`. An
        /// `NSUInteger`, so `usize` -- a signedness mismatch here aborts the
        /// process rather than unwinding.
        const ACTIVATE_IGNORING_OTHER_APPS: usize = 1 << 1;

        let Some(window) = scap_targets::Window::from_id(id) else {
            tracing::warn!(%id, "focus target window: window not found");
            return false;
        };
        // `pid_t` -- `i32`, which is what `owner_pid` hands back.
        let Some(pid) = window.raw_handle().owner_pid() else {
            tracing::warn!(%id, "focus target window: no owner pid");
            return false;
        };

        unsafe {
            let running: *mut AnyObject = msg_send![
                class!(NSRunningApplication),
                runningApplicationWithProcessIdentifier: pid
            ];
            if running.is_null() {
                tracing::warn!(%id, pid, "focus target window: no running application");
                return false;
            }
            let activated: bool =
                msg_send![running, activateWithOptions: ACTIVATE_IGNORING_OTHER_APPS];
            tracing::info!(%id, pid, activated, "focused the picked capture target");
            activated
        }
    }

    pub fn install_url_scheme_handler() {
        install_get_url_handler();
    }

    fn install_get_url_handler() {
        type OsType = u32;
        type OsErr = i16;

        #[repr(C)]
        struct AeDesc {
            descriptor_type: OsType,
            data_handle: *mut std::ffi::c_void,
        }

        #[link(name = "CoreServices", kind = "framework")]
        unsafe extern "C" {
            fn AEInstallEventHandler(
                the_ae_event_class: OsType,
                the_ae_event_id: OsType,
                handler: unsafe extern "C" fn(*const AeDesc, *mut AeDesc, isize) -> OsErr,
                handler_refcon: isize,
                is_sys_handler: u8,
            ) -> OsErr;

            fn AEGetParamPtr(
                the_apple_event: *const AeDesc,
                the_ae_keyword: OsType,
                desired_type: OsType,
                actual_type: *mut OsType,
                data_ptr: *mut std::ffi::c_void,
                maximum_size: isize,
                actual_size: *mut isize,
            ) -> OsErr;
        }

        const INTERNET_EVENT_CLASS: OsType = u32::from_be_bytes(*b"GURL");
        const GET_URL: OsType = u32::from_be_bytes(*b"GURL");
        const KEY_DIRECT_OBJECT: OsType = u32::from_be_bytes(*b"----");
        const TYPE_UTF8_TEXT: OsType = u32::from_be_bytes(*b"utf8");

        unsafe extern "C" fn handle_get_url(
            event: *const AeDesc,
            _reply: *mut AeDesc,
            _refcon: isize,
        ) -> OsErr {
            let mut actual_type = 0u32;
            let mut actual_size = 0isize;
            // Heap, and 64 KiB rather than the old 4 KiB stack array: an
            // `action` deep link carries a URL-encoded JSON payload (window
            // titles, screen names -- see `crate::deeplink`), and the Tauri
            // deep-link plugin it mirrors imposes no length cap. Anything
            // longer still is truncated to a URL that fails to parse and is
            // dropped, never mis-executed.
            let mut buffer = vec![0u8; 64 * 1024];
            let status = unsafe {
                AEGetParamPtr(
                    event,
                    KEY_DIRECT_OBJECT,
                    TYPE_UTF8_TEXT,
                    &mut actual_type,
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as isize,
                    &mut actual_size,
                )
            };
            if status == 0 && actual_size > 0 {
                let len = (actual_size as usize).min(buffer.len());
                if let Ok(url) = std::str::from_utf8(&buffer[..len]) {
                    // Auth callbacks and `action` URLs both come through this
                    // one AppleEvent; `deeplink` forwards to the sign-in flow
                    // and parses actions itself.
                    crate::deeplink::submit_deep_link(url.trim_end_matches('\0'));
                }
            }
            0
        }

        unsafe {
            let _ = AEInstallEventHandler(INTERNET_EVENT_CLASS, GET_URL, handle_get_url, 0, 0);
        }
    }

    /// `current_desktop_background_source_path` (`src-tauri/recording.rs:271-305`):
    /// the file behind the main screen's desktop picture.
    pub fn desktop_picture_path() -> Option<std::path::PathBuf> {
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;

        unsafe {
            // Raw messages rather than `objc2_app_kit::NSScreen`: the typed
            // binding needs the `NSScreen` feature, and the rule here is that
            // objc2-app-kit's version stays pinned to gpui's so no second
            // objc2 universe gets built.
            let screen: *mut AnyObject = msg_send![class!(NSScreen), mainScreen];
            if screen.is_null() {
                return None;
            }
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return None;
            }
            let url: *mut AnyObject = msg_send![workspace, desktopImageURLForScreen: screen];
            if url.is_null() {
                return None;
            }
            let path: *mut NSString = msg_send![url, path];
            if path.is_null() {
                return None;
            }
            let path = (*path).to_string();
            (!path.is_empty()).then(|| std::path::PathBuf::from(path))
        }
    }

    // -- Activation policy (the dock icon) -----------------------------------

    /// `NSApplicationActivationPolicyRegular`: dock icon, menu bar, the lot.
    const NS_ACTIVATION_POLICY_REGULAR: isize = 0;
    /// `NSApplicationActivationPolicyAccessory`: no dock icon, and **no menu
    /// bar** -- which is why [`crate::menus`] re-activates the app after
    /// putting the policy back.
    const NS_ACTIVATION_POLICY_ACCESSORY: isize = 1;

    /// `macos_sync_activation_policy` (`src-tauri/src/permissions.rs:173-183`):
    /// `Regular` when the dock icon should show, `Accessory` when it should
    /// not. Tauri's `set_dock_visibility` is the same `setActivationPolicy:`
    /// underneath, so the pair of calls over there is this one call here.
    ///
    /// `setActivationPolicy:` takes an `NSInteger`, so the argument must be
    /// `isize` -- objc2's message-send verification *aborts* the process on the
    /// unsigned spelling ("expected argument at index 0 to have type code 'q',
    /// but found 'Q'"), the same trap [`confirm_dialog`] documents in the other
    /// direction.
    pub fn set_activation_policy(regular: bool) -> bool {
        use objc2::{class, msg_send};
        let policy = if regular {
            NS_ACTIVATION_POLICY_REGULAR
        } else {
            NS_ACTIVATION_POLICY_ACCESSORY
        };
        unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if app.is_null() {
                return false;
            }
            msg_send![app, setActivationPolicy: policy]
        }
    }

    /// The policy AppKit currently reports, for the dock-policy probe.
    pub fn activation_policy() -> isize {
        use objc2::{class, msg_send};
        unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if app.is_null() {
                return -1;
            }
            msg_send![app, activationPolicy]
        }
    }

    // -- The About panel ------------------------------------------------------

    /// `PredefinedMenuItem::about(.., AboutMetadata { name, version, .. })`,
    /// which on macOS is `orderFrontStandardAboutPanelWithOptions:`.
    ///
    /// The Tauri metadata also carries `copyright` and `publisher` from
    /// `tauri.conf.json` -- neither key exists in that file, so both are `None`
    /// there and there is nothing to pass here either.
    ///
    /// Spins no modal run loop of its own (the panel is an ordinary window), but
    /// ordering a window front re-enters gpui's window callbacks, so it keeps
    /// the [`place_overlay_panel`] rule: call it from a task, never inside an
    /// update.
    pub fn show_about_panel(name: &str, version: &str) {
        use objc2::{class, msg_send};
        use objc2_foundation::{NSArray, NSString};

        unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if app.is_null() {
                return;
            }
            // `dictionaryWithObjects:forKeys:` rather than a typed
            // `NSDictionary` constructor, for the reason
            // [`desktop_picture_path`] gives: the typed binding needs another
            // objc2-app-kit/foundation feature, and the rule here is that those
            // versions stay pinned to gpui's.
            let values =
                NSArray::from_vec(vec![NSString::from_str(name), NSString::from_str(version)]);
            let keys = NSArray::from_vec(vec![
                NSString::from_str("ApplicationName"),
                NSString::from_str("ApplicationVersion"),
            ]);
            let options: *mut AnyObject = msg_send![
                class!(NSDictionary),
                dictionaryWithObjects: &*values,
                forKeys: &*keys,
            ];
            let _: () = msg_send![app, orderFrontStandardAboutPanelWithOptions: options];
        }
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

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
pub use windows::*;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod stub {
    use gpui::Window;

    use super::{ForcedAppearance, MaterialKind, PanelBehavior};

    pub fn apply_window_theme(_window: &Window, _appearance: ForcedAppearance) {}
    pub fn window_is_dark(_window: &Window) -> Option<bool> {
        None
    }

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
    pub fn debug_titlebar_state(_window: &Window) -> Option<String> {
        None
    }
    pub fn restore_borderless_style(_native: &NativeWindow) {}
    pub fn remove_popup_window_chrome(_native: &NativeWindow) {}
    pub fn place_overlay_panel(
        _native: &NativeWindow,
        _x: f64,
        _y: f64,
        _width: f64,
        _height: f64,
        _level: isize,
    ) {
    }
    pub fn kick_display_link(_window: &Window) {}
    pub fn apply_panel_behavior(window: &Window, behavior: PanelBehavior) {
        let _ = (behavior.level, behavior.join_all_spaces, behavior.shadow);
        apply_always_on_top(window);
    }

    fn apply_always_on_top(window: &Window) {
        #[cfg(windows)]
        {
            use raw_window_handle::{HasWindowHandle, RawWindowHandle};
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos,
            };
            if let Ok(handle) = HasWindowHandle::window_handle(window)
                && let RawWindowHandle::Win32(win) = handle.as_raw()
            {
                let hwnd = win.hwnd.get() as windows_sys::Win32::Foundation::HWND;
                unsafe {
                    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                }
            }
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        apply_x11_always_on_top(window);
        #[cfg(not(any(windows, unix)))]
        let _ = window;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    fn apply_x11_always_on_top(window: &Window) {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::{
            CLIENT_MESSAGE_EVENT, ClientMessageEvent, ConnectionExt, EventMask,
        };

        let Ok(handle) = HasWindowHandle::window_handle(window) else {
            return;
        };
        let window_id = match handle.as_raw() {
            RawWindowHandle::Xlib(xlib) => xlib.window as u32,
            RawWindowHandle::Xcb(xcb) => xcb.window.get(),
            _ => return,
        };
        let Ok((conn, screen_num)) = x11rb::connect(None) else {
            return;
        };
        let screen = &conn.setup().roots[screen_num];
        let Ok(state) = conn.intern_atom(false, b"_NET_WM_STATE") else {
            return;
        };
        let Ok(above) = conn.intern_atom(false, b"_NET_WM_STATE_ABOVE") else {
            return;
        };
        let (Ok(state), Ok(above)) = (state.reply(), above.reply()) else {
            return;
        };
        let event = ClientMessageEvent {
            response_type: CLIENT_MESSAGE_EVENT,
            format: 32,
            sequence: 0,
            window: window_id,
            type_: state.atom,
            data: [1, above.atom, 0, 0, 0].into(),
        };
        let _ = conn.send_event(
            false,
            screen.root,
            EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
            event,
        );
        let _ = conn.flush();
    }
    pub fn hide_native(_native: &NativeWindow) {}
    pub fn show_native(_native: &NativeWindow) {}

    #[cfg(target_os = "linux")]
    pub fn remove_x11_window_decorations(window: &Window) -> anyhow::Result<()> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::{ConnectionExt, PropMode};
        use x11rb::wrapper::ConnectionExt as _;

        let window_id = match HasWindowHandle::window_handle(window)?.as_raw() {
            RawWindowHandle::Xlib(handle) => u32::try_from(handle.window)?,
            RawWindowHandle::Xcb(handle) => handle.window.get(),
            _ => return Ok(()),
        };
        let (connection, _) = x11rb::connect(None)?;
        let atom = connection
            .intern_atom(false, b"_MOTIF_WM_HINTS")?
            .reply()?
            .atom;
        connection
            .change_property32(PropMode::REPLACE, window_id, atom, atom, &[2, 0, 0, 0, 0])?
            .check()?;
        connection.flush()?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub fn set_x11_window_visible(window: &Window, visible: bool) -> anyhow::Result<()> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::ConnectionExt;

        let window_id = match HasWindowHandle::window_handle(window)?.as_raw() {
            RawWindowHandle::Xlib(handle) => u32::try_from(handle.window)?,
            RawWindowHandle::Xcb(handle) => handle.window.get(),
            _ => return Ok(()),
        };
        let (connection, _) = x11rb::connect(None)?;
        if visible {
            connection.map_window(window_id)?.check()?;
        } else {
            connection.unmap_window(window_id)?.check()?;
        }
        connection.flush()?;
        Ok(())
    }

    pub fn window_frame(_native: &NativeWindow) -> (f64, f64, f64, f64) {
        (0., 0., 0., 0.)
    }
    pub fn set_window_frame(_native: &NativeWindow, _x: f64, _y: f64, _width: f64, _height: f64) {}
    pub fn order_front_native(_native: &NativeWindow) {}
    pub fn frame_is_on_screen(_x: f64, _y: f64, _width: f64, _height: f64) -> bool {
        true
    }

    pub fn close_native(_native: &NativeWindow) {}
    pub fn set_dock_icon(_png: &[u8]) {}
    pub fn escape_hotkey_events() -> flume::Receiver<()> {
        // A channel whose sender is dropped immediately: the drain task's
        // `recv` errors once and the task exits.
        flume::unbounded().1
    }
    pub fn register_escape_hotkey() {}
    pub fn unregister_escape_hotkey() {}
    pub fn minimize_native(_native: &NativeWindow) {}
    pub fn zoom_native(_native: &NativeWindow) {}
    pub fn toggle_fullscreen_native(_native: &NativeWindow) {}
    pub fn window_is_visible(_window: &Window) -> bool {
        false
    }
    pub fn show_window_without_focus(_window: &Window) {}
    pub fn window_number(_window: &Window) -> Option<isize> {
        None
    }
    pub fn open_image_panel(_extensions: &[&str]) -> Option<std::path::PathBuf> {
        None
    }
    pub fn open_audio_panel() -> Option<std::path::PathBuf> {
        None
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

    /// No-op off macOS: the Tauri command's other arm is `SetForegroundWindow`
    /// (+ a conditional `SW_RESTORE`) on an `HWND`, and this app has no Windows
    /// window layer yet.
    pub fn focus_capture_target_window(_id: &scap_targets::WindowId) -> bool {
        false
    }

    pub fn install_url_scheme_handler() {}

    pub fn save_file_panel(suggested: &str, extensions: &[&str]) -> Option<std::path::PathBuf> {
        let mut dialog = rfd::FileDialog::new().set_file_name(suggested);
        if !extensions.is_empty() {
            dialog = dialog.add_filter("Export", extensions);
        }
        dialog.save_file()
    }

    pub fn copy_file_to_clipboard(path: &std::path::Path) -> Result<(), String> {
        #[cfg(windows)]
        {
            let _ = path;
            Err("Copy to clipboard is not available yet on Windows".into())
        }
        #[cfg(not(windows))]
        {
            let uri = format!("file://{}", path.display());
            let copied = std::process::Command::new("wl-copy")
                .arg(&uri)
                .status()
                .ok()
                .is_some_and(|status| status.success())
                || std::process::Command::new("xclip")
                    .args(["-selection", "clipboard"])
                    .arg(path)
                    .status()
                    .ok()
                    .is_some_and(|status| status.success());
            if copied {
                Ok(())
            } else {
                Err("Failed to copy file to clipboard".into())
            }
        }
    }

    pub fn copy_image_to_clipboard(path: &std::path::Path) -> Result<(), String> {
        copy_file_to_clipboard(path)
    }
    pub fn desktop_picture_path() -> Option<std::path::PathBuf> {
        None
    }
    pub fn set_activation_policy(_regular: bool) -> bool {
        false
    }
    pub fn activation_policy() -> isize {
        -1
    }
    pub fn show_about_panel(_name: &str, _version: &str) {}
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub use stub::*;

#[cfg(test)]
mod tests {
    #[test]
    fn native_quit_permission_is_consumed_by_exactly_one_callback() {
        let (requests, receiver) = super::NativeQuitRequests::new();
        requests.permit_exit();
        assert!(requests.request());
        assert!(receiver.try_recv().is_err());
        assert!(!requests.request());
        assert_eq!(receiver.try_recv(), Ok(()));
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn concurrent_native_quit_requests_are_cancelled_and_coalesced() {
        let (requests, receiver) = super::NativeQuitRequests::new();
        let requests = std::sync::Arc::new(requests);
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let requests = requests.clone();
                std::thread::spawn(move || requests.request())
            })
            .collect();
        for thread in threads {
            assert!(!thread.join().unwrap());
        }
        assert_eq!(receiver.try_recv(), Ok(()));
        assert!(receiver.try_recv().is_err());
        assert!(!requests.request());
        assert_eq!(receiver.try_recv(), Ok(()));
    }

    #[test]
    fn concurrent_native_callbacks_cannot_reuse_an_exit_permit() {
        let (requests, receiver) = super::NativeQuitRequests::new();
        requests.permit_exit();
        let requests = std::sync::Arc::new(requests);
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let requests = requests.clone();
                std::thread::spawn(move || requests.request())
            })
            .collect();
        let permitted = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|permitted| *permitted)
            .count();
        assert_eq!(permitted, 1);
        assert_eq!(receiver.try_recv(), Ok(()));
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn missing_native_quit_consumer_never_authorizes_termination() {
        let (requests, receiver) = super::NativeQuitRequests::new();
        drop(receiver);
        assert!(!requests.request());
    }

    #[test]
    fn confirmation_accepts_native_ok_and_matching_custom_label_only() {
        let accept = "Install update";

        assert!(super::confirmation_accepted(
            rfd::MessageDialogResult::Ok,
            accept
        ));
        assert!(super::confirmation_accepted(
            rfd::MessageDialogResult::Custom(accept.to_string()),
            accept
        ));
        assert!(!super::confirmation_accepted(
            rfd::MessageDialogResult::Custom("Ignore".to_string()),
            accept
        ));
        assert!(!super::confirmation_accepted(
            rfd::MessageDialogResult::Cancel,
            accept
        ));
        assert!(!super::confirmation_accepted(
            rfd::MessageDialogResult::No,
            accept
        ));
        assert!(!super::confirmation_accepted(
            rfd::MessageDialogResult::Yes,
            accept
        ));
    }
}
