pub mod menu;
mod sc_shareable_content;

use objc2::{MainThreadMarker, msg_send, sel};
use objc2_app_kit::NSWindow;
pub use sc_shareable_content::*;
use tauri::WebviewWindow;

const TAURI_VIBRANCY_VIEW_TAG: isize = 91376254;
const LIQUID_GLASS_IDENTIFIER: &str = "so.cap.liquid-glass-background";

unsafe fn remove_tagged_subview(container: cocoa::base::id, tag: isize) {
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let responds_to_view_with_tag: bool =
            msg_send![container, respondsToSelector: sel!(viewWithTag:)];
        if !responds_to_view_with_tag {
            return;
        }

        let view: cocoa::base::id = msg_send![container, viewWithTag: tag];
        if view != cocoa::base::nil {
            let _: () = msg_send![view, removeFromSuperview];
        }
    }
}

unsafe fn remove_liquid_glass_subviews(
    container: cocoa::base::id,
    identifier: cocoa::base::id,
    glass_class: *const objc::runtime::Class,
) {
    use cocoa::base::{id, nil};
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let subviews: id = msg_send![container, subviews];
        if subviews == nil {
            return;
        }

        let count: usize = msg_send![subviews, count];
        for index in (0..count).rev() {
            let view: id = msg_send![subviews, objectAtIndex: index];
            if view == nil {
                continue;
            }

            let is_glass_view: bool = msg_send![view, isKindOfClass: glass_class];
            if is_glass_view {
                let _: () = msg_send![view, removeFromSuperview];
                continue;
            }

            let responds_to_identifier: bool =
                msg_send![view, respondsToSelector: sel!(identifier)];
            if !responds_to_identifier {
                continue;
            }

            let view_identifier: id = msg_send![view, identifier];
            if view_identifier == nil {
                continue;
            }

            let matches_identifier: bool = msg_send![view_identifier, isEqualToString: identifier];
            if matches_identifier {
                let _: () = msg_send![view, removeFromSuperview];
            }
        }
    }
}

pub fn apply_liquid_glass_background(
    window: &tauri::Window,
    enabled: bool,
    radius: f64,
) -> Result<bool, String> {
    use cocoa::{
        base::{id, nil},
        foundation::{NSRect, NSString},
    };
    use objc::{class, msg_send, runtime::Class, sel, sel_impl};

    unsafe {
        let ns_window = window
            .ns_window()
            .map_err(|error| format!("Failed to get native window handle: {error}"))?
            as id;
        let content_view: id = msg_send![ns_window, contentView];

        if content_view == nil {
            return Err("Window has no content view".into());
        }

        let Some(glass_class) = Class::get("NSGlassEffectView") else {
            // No NSGlassEffectView (pre-macOS-26) — the caller uses vibrancy.
            if enabled {
                crate::crash_sentinel::set_liquid_glass_outcome("unsupported");
            }
            return Ok(false);
        };
        let glass_class = glass_class as *const Class;
        let glass_identifier = NSString::alloc(nil).init_str(LIQUID_GLASS_IDENTIFIER);

        if !enabled {
            teardown_liquid_glass_ns(ns_window);
            return Ok(false);
        }

        remove_liquid_glass_subviews(content_view, glass_identifier, glass_class);

        // Clip the content view itself to the same continuous (squircle) curve we apply
        // to the NSGlassEffectView below. Without this, WebKit's CSS border-radius on
        // `.cap-window-shell` and the window's Core Animation corner are rasterised by
        // different engines and don't align pixel-perfectly, producing the visible inner
        // "second border" inside the rounded corner. This is plain Core Animation (no
        // private SPI / no WindowServer risk), so we apply it up front — it must clip
        // BOTH the glass view and the vibrancy fallback, otherwise the artifact returns
        // on the fallback path (most visibly on the larger-radius settings window).
        let _: () = msg_send![content_view, setWantsLayer: true];
        let content_layer: id = msg_send![content_view, layer];
        if content_layer != nil {
            let _: () = msg_send![content_layer, setCornerRadius: radius];
            let _: () = msg_send![content_layer, setMasksToBounds: true];
            let continuous = NSString::alloc(nil).init_str("continuous");
            let _: () = msg_send![content_layer, setCornerCurve: continuous];
        }

        let bounds: NSRect = msg_send![content_view, bounds];
        let glass_view: id = msg_send![glass_class, alloc];
        let glass_view: id = msg_send![glass_view, initWithFrame: bounds];

        if glass_view == nil {
            crate::crash_sentinel::set_liquid_glass_outcome("fallback");
            return Ok(false);
        }

        let responds_to_set_identifier: bool =
            msg_send![glass_view, respondsToSelector: sel!(setIdentifier:)];
        if responds_to_set_identifier {
            let _: () = msg_send![glass_view, setIdentifier: glass_identifier];
        }

        let responds_to_set_corner_radius: bool =
            msg_send![glass_view, respondsToSelector: sel!(setCornerRadius:)];
        if responds_to_set_corner_radius {
            let _: () = msg_send![glass_view, setCornerRadius: radius];
        }

        // Pin the glass to its "always-active" representation so it keeps re-rendering
        // the live backdrop regardless of which window currently has key state. The
        // default for an NSVisualEffectView-derived view is FollowsWindowActiveState,
        // which dims the material whenever another Cap window (camera, settings, etc.)
        // becomes key and masks the backdrop reactivity that's the whole point of
        // Liquid Glass. NSGlassEffectView is private SPI introduced in macOS 26, so we
        // probe multiple state knobs (`setState:`, `setActive:`) instead of assuming a
        // single inheritance path.
        //
        // macOS 26.3 shipped an NSGlassEffectView that responds to neither selector,
        // so the pin silently fails. We MUST NOT proceed to disable occlusion
        // detection in that state: an occlusion-suppressed window whose private glass
        // view is not pinned active leaves WindowServer unable to ever quiesce the
        // surface, which wedges the compositor when the window is hidden/closed and
        // takes down the whole login session. When we can't pin the material, abandon
        // the private SPI entirely and let the caller fall back to NSVisualEffectView
        // vibrancy (Ok(false)).
        if !force_glass_view_always_active(glass_view) {
            // Never entered the view hierarchy; balance the alloc and bail. The
            // content-layer squircle clip applied above is kept (plain Core Animation,
            // not a WindowServer/occlusion mutation) so the vibrancy fallback still gets
            // the aligned rounded corner.
            let _: () = msg_send![glass_view, release];
            crate::crash_sentinel::set_liquid_glass_outcome("fallback");
            return Ok(false);
        }

        remove_tagged_subview(content_view, TAURI_VIBRANCY_VIEW_TAG);

        let clear_color: id = msg_send![class!(NSColor), clearColor];
        let _: () = msg_send![ns_window, setOpaque: false];
        let _: () = msg_send![ns_window, setBackgroundColor: clear_color];

        // Stop AppKit from marking the window "occluded" when another app becomes
        // frontmost. The OS treats a window-without-key as occluded for power-saving
        // purposes and freezes the contentView's rendering loop — which means the
        // NSGlassEffectView's backdrop sampling pauses on the last frame, so the
        // glass shows whatever happened to be behind us at the moment we lost focus
        // (Safari, etc.) instead of reflecting the live backdrop change. There's no
        // public API for this; probe the private setters used across NSWindow and
        // NSPanel SPI variants, plus the same SPI on the embedded WKWebView since
        // its pause is what actually freezes the contentView's render loop. Only
        // reached once the glass view pinned active (see above); reversed by
        // teardown_liquid_glass_ns before the window is hidden or the process exits.
        disable_window_occlusion_detection(ns_window);
        disable_webview_occlusion_detection(content_view);

        let _: () = msg_send![glass_view, setAutoresizingMask: 18usize];
        let _: () = msg_send![
            content_view,
            addSubview: glass_view
            positioned: -1isize
            relativeTo: nil
        ];

        // Re-apply after the view enters the hierarchy: some private AppKit views
        // reset state machine fields on `viewDidMoveToWindow:`, so the post-add pass
        // is what actually sticks.
        force_glass_view_always_active(glass_view);

        crate::crash_sentinel::set_liquid_glass_outcome("applied");
        Ok(true)
    }
}

unsafe fn disable_window_occlusion_detection(ns_window: cocoa::base::id) {
    use objc::{msg_send, sel, sel_impl};

    // Apple uses different naming for this private SPI between NSWindow and
    // various AppKit subclasses (and the name has shifted across OS versions).
    // Try each variant directly; respondsToSelector keeps the call safe.
    unsafe {
        let responds: bool = msg_send![
            ns_window,
            respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)
        ];
        if responds {
            let _: () = msg_send![ns_window, _setWindowOcclusionDetectionEnabled: false];
            tracing::info!(
                target: "cap_desktop_lib::liquid_glass",
                "Disabled window occlusion detection via _setWindowOcclusionDetectionEnabled:"
            );
            return;
        }

        let responds: bool = msg_send![
            ns_window,
            respondsToSelector: sel!(setWindowOcclusionDetectionEnabled:)
        ];
        if responds {
            let _: () = msg_send![ns_window, setWindowOcclusionDetectionEnabled: false];
            tracing::info!(
                target: "cap_desktop_lib::liquid_glass",
                "Disabled window occlusion detection via setWindowOcclusionDetectionEnabled:"
            );
            return;
        }

        let responds: bool = msg_send![
            ns_window,
            respondsToSelector: sel!(_setOcclusionDetectionEnabled:)
        ];
        if responds {
            let _: () = msg_send![ns_window, _setOcclusionDetectionEnabled: false];
            tracing::info!(
                target: "cap_desktop_lib::liquid_glass",
                "Disabled window occlusion detection via _setOcclusionDetectionEnabled:"
            );
            return;
        }

        let responds: bool = msg_send![
            ns_window,
            respondsToSelector: sel!(setOcclusionDetectionEnabled:)
        ];
        if responds {
            let _: () = msg_send![ns_window, setOcclusionDetectionEnabled: false];
            tracing::info!(
                target: "cap_desktop_lib::liquid_glass",
                "Disabled window occlusion detection via setOcclusionDetectionEnabled:"
            );
            return;
        }

        tracing::warn!(
            target: "cap_desktop_lib::liquid_glass",
            "NSWindow does not respond to any known occlusion-detection selector; \
             glass backdrop will freeze when app deactivates"
        );
    }
}

unsafe fn disable_webview_occlusion_detection(content_view: cocoa::base::id) {
    use cocoa::base::id;
    use objc::{msg_send, runtime::Class, sel, sel_impl};

    unsafe {
        let Some(wkwebview_class) = Class::get("WKWebView") else {
            tracing::warn!(
                target: "cap_desktop_lib::liquid_glass",
                "WKWebView class not found; skipping WebView occlusion fix"
            );
            return;
        };
        let wkwebview_class = wkwebview_class as *const Class;

        let subviews: id = msg_send![content_view, subviews];
        if subviews == cocoa::base::nil {
            return;
        }

        let count: usize = msg_send![subviews, count];
        for index in 0..count {
            let subview: id = msg_send![subviews, objectAtIndex: index];
            if subview == cocoa::base::nil {
                continue;
            }

            let is_webview: bool = msg_send![subview, isKindOfClass: wkwebview_class];
            if !is_webview {
                continue;
            }

            let responds: bool = msg_send![
                subview,
                respondsToSelector: sel!(_setWebViewWindowOcclusionDetectionEnabled:)
            ];
            if responds {
                let _: () = msg_send![subview, _setWebViewWindowOcclusionDetectionEnabled: false];
                tracing::info!(
                    target: "cap_desktop_lib::liquid_glass",
                    "Disabled WKWebView occlusion via _setWebViewWindowOcclusionDetectionEnabled:"
                );
                return;
            }

            let responds: bool = msg_send![
                subview,
                respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)
            ];
            if responds {
                let _: () = msg_send![subview, _setWindowOcclusionDetectionEnabled: false];
                tracing::info!(
                    target: "cap_desktop_lib::liquid_glass",
                    "Disabled WKWebView occlusion via _setWindowOcclusionDetectionEnabled:"
                );
                return;
            }

            tracing::warn!(
                target: "cap_desktop_lib::liquid_glass",
                "WKWebView does not respond to any known occlusion-detection selector"
            );
            return;
        }

        tracing::warn!(
            target: "cap_desktop_lib::liquid_glass",
            "No WKWebView found in content view subviews"
        );
    }
}

/// Pin the glass material to its always-active representation. Returns whether the
/// view actually responded to a known pinning selector. A `false` return means this
/// macOS build's NSGlassEffectView SPI differs from what we understand (notably 26.3,
/// where it responds to neither `setState:` nor `setActive:`) and the material must
/// NOT be relied upon — see `apply_liquid_glass_background`.
unsafe fn force_glass_view_always_active(glass_view: cocoa::base::id) -> bool {
    use cocoa::base::id;
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let responds_to_set_state: bool =
            msg_send![glass_view, respondsToSelector: sel!(setState:)];
        if responds_to_set_state {
            // NSVisualEffectStateActive == 1
            let _: () = msg_send![glass_view, setState: 1isize];
            tracing::info!(target: "cap_desktop_lib::liquid_glass", "NSGlassEffectView responds to setState:");
        }

        let responds_to_set_active: bool =
            msg_send![glass_view, respondsToSelector: sel!(setActive:)];
        if responds_to_set_active {
            let _: () = msg_send![glass_view, setActive: true];
            tracing::info!(target: "cap_desktop_lib::liquid_glass", "NSGlassEffectView responds to setActive:");
        }

        if !responds_to_set_state && !responds_to_set_active {
            tracing::warn!(
                target: "cap_desktop_lib::liquid_glass",
                "NSGlassEffectView responds to neither setState: nor setActive: — \
                 cannot pin material to always-active; falling back to vibrancy"
            );
            return false;
        }

        // If the glass view internally wraps an NSVisualEffectView (rather than
        // subclassing it), the state property on the outer view won't propagate.
        // Walk one level of subviews and pin any visual-effect-like state we find.
        let subviews: id = msg_send![glass_view, subviews];
        if subviews != cocoa::base::nil {
            let count: usize = msg_send![subviews, count];
            for index in 0..count {
                let subview: id = msg_send![subviews, objectAtIndex: index];
                if subview == cocoa::base::nil {
                    continue;
                }

                let subview_responds_to_set_state: bool =
                    msg_send![subview, respondsToSelector: sel!(setState:)];
                if subview_responds_to_set_state {
                    let _: () = msg_send![subview, setState: 1isize];
                }
            }
        }

        true
    }
}

unsafe fn enable_window_occlusion_detection(ns_window: cocoa::base::id) {
    use objc::{msg_send, sel, sel_impl};

    // Mirror disable_window_occlusion_detection: re-enable via whichever private SPI
    // variant this AppKit build responds to, so the OS can quiesce the surface again.
    unsafe {
        let responds: bool = msg_send![
            ns_window,
            respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)
        ];
        if responds {
            let _: () = msg_send![ns_window, _setWindowOcclusionDetectionEnabled: true];
            return;
        }

        let responds: bool = msg_send![
            ns_window,
            respondsToSelector: sel!(setWindowOcclusionDetectionEnabled:)
        ];
        if responds {
            let _: () = msg_send![ns_window, setWindowOcclusionDetectionEnabled: true];
            return;
        }

        let responds: bool = msg_send![
            ns_window,
            respondsToSelector: sel!(_setOcclusionDetectionEnabled:)
        ];
        if responds {
            let _: () = msg_send![ns_window, _setOcclusionDetectionEnabled: true];
            return;
        }

        let responds: bool = msg_send![
            ns_window,
            respondsToSelector: sel!(setOcclusionDetectionEnabled:)
        ];
        if responds {
            let _: () = msg_send![ns_window, setOcclusionDetectionEnabled: true];
        }
    }
}

unsafe fn enable_webview_occlusion_detection(content_view: cocoa::base::id) {
    use cocoa::base::id;
    use objc::{msg_send, runtime::Class, sel, sel_impl};

    // Re-enumerate the live WKWebView subview (its identity/index can change between
    // apply and teardown) and restore occlusion detection, mirroring the disable path.
    unsafe {
        let Some(wkwebview_class) = Class::get("WKWebView") else {
            return;
        };
        let wkwebview_class = wkwebview_class as *const Class;

        let subviews: id = msg_send![content_view, subviews];
        if subviews == cocoa::base::nil {
            return;
        }

        let count: usize = msg_send![subviews, count];
        for index in 0..count {
            let subview: id = msg_send![subviews, objectAtIndex: index];
            if subview == cocoa::base::nil {
                continue;
            }

            let is_webview: bool = msg_send![subview, isKindOfClass: wkwebview_class];
            if !is_webview {
                continue;
            }

            let responds: bool = msg_send![
                subview,
                respondsToSelector: sel!(_setWebViewWindowOcclusionDetectionEnabled:)
            ];
            if responds {
                let _: () = msg_send![subview, _setWebViewWindowOcclusionDetectionEnabled: true];
                return;
            }

            let responds: bool = msg_send![
                subview,
                respondsToSelector: sel!(_setWindowOcclusionDetectionEnabled:)
            ];
            if responds {
                let _: () = msg_send![subview, _setWindowOcclusionDetectionEnabled: true];
                return;
            }

            return;
        }
    }
}

/// Reverse every WindowServer-visible mutation `apply_liquid_glass_background` makes:
/// remove the private NSGlassEffectView (the load-bearing step — it synchronously
/// detaches the private compositor relationship), then restore window/WKWebView
/// occlusion detection and window opacity. MUST run on the AppKit main thread.
unsafe fn teardown_liquid_glass_ns(ns_window: cocoa::base::id) {
    use cocoa::{
        base::{id, nil},
        foundation::NSString,
    };
    use objc::{msg_send, runtime::Class, sel, sel_impl};

    unsafe {
        let content_view: id = msg_send![ns_window, contentView];
        if content_view == nil {
            return;
        }

        if let Some(glass_class) = Class::get("NSGlassEffectView") {
            let glass_identifier = NSString::alloc(nil).init_str(LIQUID_GLASS_IDENTIFIER);
            remove_liquid_glass_subviews(
                content_view,
                glass_identifier,
                glass_class as *const Class,
            );
        }

        enable_window_occlusion_detection(ns_window);
        enable_webview_occlusion_detection(content_view);
        let _: () = msg_send![ns_window, setOpaque: true];
    }
}

/// Tear down liquid glass on every webview window. MUST be called on the AppKit main
/// thread (e.g. from the `RunEvent::Exit` handler, which runs on main). Returns the
/// number of windows processed.
pub fn teardown_all_liquid_glass_on_main(app: &tauri::AppHandle) -> usize {
    use tauri::Manager;

    let mut count = 0usize;
    for (_label, window) in app.webview_windows() {
        if let Ok(ns_window) = window.ns_window() {
            unsafe {
                teardown_liquid_glass_ns(ns_window as cocoa::base::id);
            }
            count += 1;
        }
    }
    count
}

/// Dispatch liquid-glass teardown onto the main thread and await it. Safe to call
/// from a tokio worker during exit: the AppKit run loop is still pumping because the
/// macOS terminate handler returned NSTerminateCancel before spawning the async exit.
pub async fn teardown_all_liquid_glass(app: &tauri::AppHandle) -> Result<(), String> {
    let app_for_closure = app.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();

    app.run_on_main_thread(move || {
        let count = teardown_all_liquid_glass_on_main(&app_for_closure);
        let _ = tx.send(count);
    })
    .map_err(|error| error.to_string())?;

    let count = rx
        .await
        .map_err(|_| "liquid glass teardown task was cancelled".to_string())?;
    tracing::info!(
        target: "cap_desktop_lib::liquid_glass",
        windows = count,
        "Tore down liquid glass before exit"
    );
    Ok(())
}

pub trait WebviewWindowExt {
    fn with_nswindow_on_main<F: FnOnce(MainThreadMarker, &NSWindow) + Send + 'static>(
        &self,
        f: F,
    ) -> tauri::Result<()>;
}

impl WebviewWindowExt for WebviewWindow {
    fn with_nswindow_on_main<F: FnOnce(MainThreadMarker, &NSWindow) + Send + 'static>(
        &self,
        f: F,
    ) -> tauri::Result<()> {
        self.run_on_main_thread({
            let webview = self.clone();
            move || {
                let nswindow = unsafe { &*webview.ns_window().expect("NSWindow not ready").cast() };
                let mtm = MainThreadMarker::new().expect("Running on main");
                f(mtm, nswindow);
            }
        })
    }
}
