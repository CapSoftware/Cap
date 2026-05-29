pub mod menu;
mod sc_shareable_content;

use objc2::{MainThreadMarker, msg_send, sel};
use objc2_app_kit::NSWindow;
pub use sc_shareable_content::*;
use tauri::WebviewWindow;

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

    const TAURI_VIBRANCY_VIEW_TAG: isize = 91376254;

    unsafe fn remove_tagged_subview(container: id, tag: isize) {
        unsafe {
            let responds_to_view_with_tag: bool =
                msg_send![container, respondsToSelector: sel!(viewWithTag:)];
            if !responds_to_view_with_tag {
                return;
            }

            let view: id = msg_send![container, viewWithTag: tag];
            if view != nil {
                let _: () = msg_send![view, removeFromSuperview];
            }
        }
    }

    unsafe fn remove_liquid_glass_subviews(
        container: id,
        identifier: id,
        glass_class: *const Class,
    ) {
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

                let matches_identifier: bool =
                    msg_send![view_identifier, isEqualToString: identifier];
                if matches_identifier {
                    let _: () = msg_send![view, removeFromSuperview];
                }
            }
        }
    }

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
            return Ok(false);
        };
        let glass_class = glass_class as *const Class;
        let glass_identifier = NSString::alloc(nil).init_str("so.cap.liquid-glass-background");

        remove_liquid_glass_subviews(content_view, glass_identifier, glass_class);

        if !enabled {
            return Ok(false);
        }

        // Clip the content view itself to the same continuous (squircle) curve
        // we apply to the NSGlassEffectView below. Without this, WebKit's CSS
        // border-radius on `.cap-window-shell` and the glass view's Core
        // Animation corner are rasterised by different engines and don't align
        // pixel-perfectly, producing the visible inner "second border" inside
        // the rounded corner. Setting cornerRadius + masksToBounds on the
        // contentView's layer (plus the continuous curve) gives us one
        // authoritative mask that clips both the WKWebView and the glass view.
        let _: () = msg_send![content_view, setWantsLayer: true];
        let content_layer: id = msg_send![content_view, layer];
        if content_layer != nil {
            let _: () = msg_send![content_layer, setCornerRadius: radius];
            let _: () = msg_send![content_layer, setMasksToBounds: true];
            let continuous = NSString::alloc(nil).init_str("continuous");
            let _: () = msg_send![content_layer, setCornerCurve: continuous];
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
        // its pause is what actually freezes the contentView's render loop.
        disable_window_occlusion_detection(ns_window);
        disable_webview_occlusion_detection(content_view);

        let bounds: NSRect = msg_send![content_view, bounds];
        let glass_view: id = msg_send![glass_class, alloc];
        let glass_view: id = msg_send![glass_view, initWithFrame: bounds];

        if glass_view == nil {
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
        force_glass_view_always_active(glass_view);

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

unsafe fn force_glass_view_always_active(glass_view: cocoa::base::id) {
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
                 cannot pin material to always-active"
            );
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
    }
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
