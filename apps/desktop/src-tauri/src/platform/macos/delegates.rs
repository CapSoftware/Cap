// TODO(Ilya): Re-write all macos code to use `objc2` crates n
///
/// Credit to @haasal, @charrondev, Hoppscotch app, Electron, Zed Editor
///
/// https://github.com/haasal
/// https://gist.github.com/charrondev
/// https://github.com/hoppscotch/hoppscotch
/// https://github.com/clearlysid/tauri-plugin-decorum/
/// (Issue) https://github.com/tauri-apps/tauri/issues/4789
/// (Gist) https://gist.github.com/charrondev/43150e940bd2771b1ea88256d491c7a9
/// (Hoppscotch) https://github.com/hoppscotch/hoppscotch/blob/286fcd2bb08a84f027b10308d1e18da368f95ebf/packages/hoppscotch-selfhost-desktop/src-tauri/src/mac/window.rs
/// (Electron) https://github.com/electron/electron/blob/38512efd25a159ddc64a54c22ef9eb6dd60064ec/shell/browser/native_window_mac.mm#L1454
///
use objc::{class, msg_send, sel, sel_impl};
use tauri::{Emitter, LogicalPosition, Runtime, Window};

pub struct UnsafeWindowHandle(pub *mut std::ffi::c_void);
unsafe impl Send for UnsafeWindowHandle {}
unsafe impl Sync for UnsafeWindowHandle {}

#[derive(Debug)]
struct WindowState<R: Runtime> {
    window: Window<R>,
    controls_inset: LogicalPosition<f64>,
}

// TODO: Respect RTL display language
// TODO: Update Height, consider supporting the scenario where the buttons are hidden by the system due to screen sharing of the window
// https://developer.apple.com/documentation/appkit/nsapplication/1428556-userinterfacelayoutdirection?language=objc
pub fn position_window_controls(
    ns_window_handle: UnsafeWindowHandle,
    inset: &LogicalPosition<f64>,
) {
    use cocoa::{
        appkit::{NSView, NSWindow, NSWindowButton, NSWindowStyleMask},
        base::id,
        foundation::NSRect,
    };

    let ns_window = ns_window_handle.0 as id;
    unsafe {
        // In native fullscreen the standard window buttons are hosted in a
        // system-managed titlebar overlay; resizing their superviews there
        // makes AppKit throw an NSException, which aborts the process once it
        // unwinds into Rust. The system positions them itself in fullscreen.
        if ns_window
            .styleMask()
            .contains(NSWindowStyleMask::NSFullScreenWindowMask)
        {
            return;
        }

        let close = ns_window.standardWindowButton_(NSWindowButton::NSWindowCloseButton);
        let minimize = ns_window.standardWindowButton_(NSWindowButton::NSWindowMiniaturizeButton);
        let zoom = ns_window.standardWindowButton_(NSWindowButton::NSWindowZoomButton);
        if close.is_null() || minimize.is_null() || zoom.is_null() {
            return;
        }

        let title_bar_container_view = close.superview().superview();
        if title_bar_container_view.is_null() {
            return;
        }

        let close_rect: NSRect = msg_send![close, frame];
        let button_height = close_rect.size.height;

        let title_bar_frame_height = button_height + inset.y;
        let mut title_bar_rect = NSView::frame(title_bar_container_view);
        title_bar_rect.size.height = title_bar_frame_height;
        title_bar_rect.origin.y = NSView::frame(ns_window).size.height - title_bar_frame_height;
        let _: () = msg_send![title_bar_container_view, setFrame: title_bar_rect];

        let window_buttons = vec![close, minimize, zoom];
        let space_between = NSView::frame(minimize).origin.x - NSView::frame(close).origin.x;
        let vertical_offset = 4.0; // Adjust this value to push buttons down

        for (i, button) in window_buttons.into_iter().enumerate() {
            let mut rect: NSRect = NSView::frame(button);
            rect.origin.x = inset.x + (i as f64 * space_between);
            rect.origin.y = ((title_bar_frame_height - button_height) / 2.0) - vertical_offset;
            button.setFrameOrigin(rect.origin);
        }
    }
}

pub fn setup<R: Runtime>(window: Window<R>, controls_inset: LogicalPosition<f64>) {
    use cocoa::appkit::NSWindow;
    use cocoa::base::{BOOL, id};
    use cocoa::foundation::NSUInteger;
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel};
    use std::ffi::c_void;

    let Ok(ns_win) = window.ns_window() else {
        tracing::warn!("Failed to get window handle for delegate setup");
        return;
    };

    // Do the initial positioning
    position_window_controls(UnsafeWindowHandle(ns_win), &controls_inset);

    // Ensure they stay in place while resizing the window.
    fn with_window_state<R: Runtime, F: FnOnce(&mut WindowState<R>) -> T, T>(
        this: &Object,
        func: F,
    ) {
        let x: *mut c_void = unsafe { *this.get_ivar("app_box") };
        // `app_box` is nulled out in `windowWillClose:`; ignore any late
        // callbacks that arrive after that instead of dereferencing null.
        if x.is_null() {
            return;
        }
        let ptr = unsafe { &mut *(x as *mut WindowState<R>) };
        func(ptr);
    }

    fn suppress_delegate_panic<T, F>(selector: &'static str, fallback: T, operation: F) -> T
    where
        F: FnOnce() -> T,
    {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation)) {
            Ok(value) => value,
            Err(_) => {
                tracing::error!(selector, "Suppressed panic in macOS window delegate");
                fallback
            }
        }
    }

    unsafe {
        let ns_win_id = ns_win as id;
        let current_delegate: id = ns_win_id.delegate();

        extern "C" fn on_window_should_close(this: &Object, _cmd: Sel, sender: id) -> BOOL {
            suppress_delegate_panic("windowShouldClose:", cocoa::base::NO, || unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                msg_send![super_del, windowShouldClose: sender]
            })
        }
        extern "C" fn on_window_will_close<R: Runtime>(this: &Object, _cmd: Sel, notification: id) {
            let super_del: id = unsafe { *this.get_ivar("super_delegate") };

            // Forward to the previous delegate first, but don't let a panic there
            // skip the cleanup below (which would bring back the leak).
            suppress_delegate_panic("windowWillClose:", (), || unsafe {
                let _: () = msg_send![super_del, windowWillClose: notification];
            });

            suppress_delegate_panic("windowWillClose:cleanup", (), || unsafe {
                // Drop the boxed `WindowState<R>` (and the `Window<R>` handle it holds)
                // that was leaked via `Box::into_raw` when this delegate was created.
                let app_box: *mut c_void = *this.get_ivar("app_box");
                if !app_box.is_null() {
                    let this_mut = this as *const Object as *mut Object;
                    (*this_mut).set_ivar("app_box", std::ptr::null_mut::<c_void>());
                    drop(Box::from_raw(app_box as *mut WindowState<R>));
                }

                // Restore the previous delegate before releasing this one, so any
                // further delegate callbacks during teardown don't hit a freed object.
                let window: id = *this.get_ivar("window");
                let _: () = msg_send![window, setDelegate: super_del];

                // NSWindow does not retain its delegate, so the reference taken when
                // this delegate was created (`new`) is the only owning one. Release
                // it now that the window is closing.
                let this_id = this as *const Object as id;
                let _: () = msg_send![this_id, release];
            });
        }
        extern "C" fn on_window_did_resize<R: Runtime>(this: &Object, _cmd: Sel, notification: id) {
            suppress_delegate_panic("windowDidResize:", (), || unsafe {
                with_window_state(this, |state: &mut WindowState<R>| {
                    if let Ok(window_handle) = state.window.ns_window() {
                        position_window_controls(
                            UnsafeWindowHandle(window_handle),
                            &state.controls_inset,
                        );
                    } else {
                        tracing::warn!("Failed to get handle to NSWindow during resize");
                    }
                });

                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidResize: notification];
            });
        }
        extern "C" fn on_window_did_move(this: &Object, _cmd: Sel, notification: id) {
            suppress_delegate_panic("windowDidMove:", (), || unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidMove: notification];
            });
        }
        extern "C" fn on_window_did_change_backing_properties(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) {
            suppress_delegate_panic("windowDidChangeBackingProperties:", (), || unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidChangeBackingProperties: notification];
            });
        }
        extern "C" fn on_window_did_become_key(this: &Object, _cmd: Sel, notification: id) {
            suppress_delegate_panic("windowDidBecomeKey:", (), || unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidBecomeKey: notification];
            });
        }
        extern "C" fn on_window_did_resign_key(this: &Object, _cmd: Sel, notification: id) {
            suppress_delegate_panic("windowDidResignKey:", (), || unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidResignKey: notification];
            });
        }
        extern "C" fn on_dragging_entered(this: &Object, _cmd: Sel, notification: id) -> BOOL {
            suppress_delegate_panic("draggingEntered:", cocoa::base::NO, || unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                msg_send![super_del, draggingEntered: notification]
            })
        }
        extern "C" fn on_prepare_for_drag_operation(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) -> BOOL {
            suppress_delegate_panic("prepareForDragOperation:", cocoa::base::NO, || unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                msg_send![super_del, prepareForDragOperation: notification]
            })
        }
        extern "C" fn on_perform_drag_operation(this: &Object, _cmd: Sel, sender: id) -> BOOL {
            suppress_delegate_panic("performDragOperation:", cocoa::base::NO, || unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                msg_send![super_del, performDragOperation: sender]
            })
        }
        extern "C" fn on_conclude_drag_operation(this: &Object, _cmd: Sel, notification: id) {
            suppress_delegate_panic("concludeDragOperation:", (), || unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, concludeDragOperation: notification];
            });
        }
        extern "C" fn on_dragging_exited(this: &Object, _cmd: Sel, notification: id) {
            suppress_delegate_panic("draggingExited:", (), || unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, draggingExited: notification];
            });
        }
        extern "C" fn on_window_will_use_full_screen_presentation_options(
            this: &Object,
            _cmd: Sel,
            window: id,
            proposed_options: NSUInteger,
        ) -> NSUInteger {
            suppress_delegate_panic(
                "window:willUseFullScreenPresentationOptions:",
                proposed_options,
                || unsafe {
                    let super_del: id = *this.get_ivar("super_delegate");
                    msg_send![super_del, window: window willUseFullScreenPresentationOptions: proposed_options]
                },
            )
        }
        extern "C" fn on_window_did_enter_full_screen<R: Runtime>(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) {
            suppress_delegate_panic("windowDidEnterFullScreen:", (), || unsafe {
                with_window_state(this, |state: &mut WindowState<R>| {
                    if let Err(err) = state.window.emit("did-enter-fullscreen", ()) {
                        tracing::warn!("Failed to emit did-enter-fullscreen: {err}");
                    }
                });

                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidEnterFullScreen: notification];
            });
        }
        extern "C" fn on_window_will_enter_full_screen<R: Runtime>(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) {
            suppress_delegate_panic("windowWillEnterFullScreen:", (), || unsafe {
                with_window_state(this, |state: &mut WindowState<R>| {
                    if let Err(err) = state.window.emit("will-enter-fullscreen", ()) {
                        tracing::warn!("Failed to emit will-enter-fullscreen: {err}");
                    }
                });

                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowWillEnterFullScreen: notification];
            });
        }
        extern "C" fn on_window_did_exit_full_screen<R: Runtime>(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) {
            suppress_delegate_panic("windowDidExitFullScreen:", (), || unsafe {
                with_window_state(this, |state: &mut WindowState<R>| {
                    if let Err(err) = state.window.emit("did-exit-fullscreen", ()) {
                        tracing::warn!("Failed to emit did-exit-fullscreen: {err}");
                    }

                    if let Ok(window_handle) = state.window.ns_window() {
                        position_window_controls(
                            UnsafeWindowHandle(window_handle),
                            &state.controls_inset,
                        );
                    } else {
                        tracing::warn!("Failed to get handle to NSWindow after exiting fullscreen");
                    }
                });

                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidExitFullScreen: notification];
            });
        }
        extern "C" fn on_window_will_exit_full_screen<R: Runtime>(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) {
            suppress_delegate_panic("windowWillExitFullScreen:", (), || unsafe {
                with_window_state(this, |state: &mut WindowState<R>| {
                    if let Err(err) = state.window.emit("will-exit-fullscreen", ()) {
                        tracing::warn!("Failed to emit will-exit-fullscreen: {err}");
                    }
                });

                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowWillExitFullScreen: notification];
            });
        }
        extern "C" fn on_window_did_fail_to_enter_full_screen(
            this: &Object,
            _cmd: Sel,
            window: id,
        ) {
            suppress_delegate_panic("windowDidFailToEnterFullScreen:", (), || unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidFailToEnterFullScreen: window];
            });
        }
        extern "C" fn on_effective_appearance_did_change(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) {
            suppress_delegate_panic("effectiveAppearanceDidChange:", (), || unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, effectiveAppearanceDidChange: notification];
            });
        }
        extern "C" fn on_effective_appearance_did_changed_on_main_thread(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) {
            suppress_delegate_panic(
                "effectiveAppearanceDidChangedOnMainThread:",
                (),
                || unsafe {
                    let super_del: id = *this.get_ivar("super_delegate");
                    let _: () = msg_send![
                        super_del,
                        effectiveAppearanceDidChangedOnMainThread: notification
                    ];
                },
            );
        }

        // Register the delegate class once and reuse it for every window. Previously a brand
        // new class was registered (with a randomized name) on every call to `setup`, which
        // permanently leaked Objective-C class metadata for the lifetime of the process.
        //
        // NOTE: `static CLASS` below is a single process-wide instance shared across every
        // monomorphization of this function, not one per `R`. `setup` is only ever called
        // with `R = tauri::Wry` in this app, so this is fine in practice; if it were ever
        // called with a different `R`, the first call's `on_*::<R>` method pointers would
        // be baked into the shared class for all `R`.
        fn get_or_register_delegate_class<R: Runtime>() -> &'static Class {
            static CLASS: std::sync::OnceLock<&'static Class> = std::sync::OnceLock::new();
            CLASS.get_or_init(|| {
                if let Some(existing) = Class::get("CapWindowDelegate") {
                    return existing;
                }

                let mut decl = match ClassDecl::new("CapWindowDelegate", class!(NSObject)) {
                    Some(decl) => decl,
                    None => {
                        return Class::get("CapWindowDelegate")
                            .expect("CapWindowDelegate should exist if already registered");
                    }
                };

                decl.add_ivar::<id>("window");
                decl.add_ivar::<*mut c_void>("app_box");
                decl.add_ivar::<id>("toolbar");
                decl.add_ivar::<id>("super_delegate");

                unsafe {
                    decl.add_method(
                        sel!(windowShouldClose:),
                        on_window_should_close as extern "C" fn(&Object, Sel, id) -> BOOL,
                    );
                    decl.add_method(
                        sel!(windowWillClose:),
                        on_window_will_close::<R> as extern "C" fn(&Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(windowDidResize:),
                        on_window_did_resize::<R> as extern "C" fn(&Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(windowDidMove:),
                        on_window_did_move as extern "C" fn(&Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(windowDidChangeBackingProperties:),
                        on_window_did_change_backing_properties as extern "C" fn(&Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(windowDidBecomeKey:),
                        on_window_did_become_key as extern "C" fn(&Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(windowDidResignKey:),
                        on_window_did_resign_key as extern "C" fn(&Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(draggingEntered:),
                        on_dragging_entered as extern "C" fn(&Object, Sel, id) -> BOOL,
                    );
                    decl.add_method(
                        sel!(prepareForDragOperation:),
                        on_prepare_for_drag_operation as extern "C" fn(&Object, Sel, id) -> BOOL,
                    );
                    decl.add_method(
                        sel!(performDragOperation:),
                        on_perform_drag_operation as extern "C" fn(&Object, Sel, id) -> BOOL,
                    );
                    decl.add_method(
                        sel!(concludeDragOperation:),
                        on_conclude_drag_operation as extern "C" fn(&Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(draggingExited:),
                        on_dragging_exited as extern "C" fn(&Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(window:willUseFullScreenPresentationOptions:),
                        on_window_will_use_full_screen_presentation_options
                            as extern "C" fn(&Object, Sel, id, NSUInteger) -> NSUInteger,
                    );
                    decl.add_method(
                        sel!(windowDidEnterFullScreen:),
                        on_window_did_enter_full_screen::<R> as extern "C" fn(&Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(windowWillEnterFullScreen:),
                        on_window_will_enter_full_screen::<R> as extern "C" fn(&Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(windowDidExitFullScreen:),
                        on_window_did_exit_full_screen::<R> as extern "C" fn(&Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(windowWillExitFullScreen:),
                        on_window_will_exit_full_screen::<R> as extern "C" fn(&Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(windowDidFailToEnterFullScreen:),
                        on_window_did_fail_to_enter_full_screen as extern "C" fn(&Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(effectiveAppearanceDidChange:),
                        on_effective_appearance_did_change as extern "C" fn(&Object, Sel, id),
                    );
                    decl.add_method(
                        sel!(effectiveAppearanceDidChangedOnMainThread:),
                        on_effective_appearance_did_changed_on_main_thread
                            as extern "C" fn(&Object, Sel, id),
                    );
                }

                decl.register()
            })
        }

        let app_state = WindowState {
            window,
            controls_inset,
        };
        let app_box = Box::into_raw(Box::new(app_state)) as *mut c_void;

        let delegate_class = get_or_register_delegate_class::<R>();
        let delegate: id = msg_send![delegate_class, new];
        (*delegate).set_ivar("window", ns_win_id);
        (*delegate).set_ivar("app_box", app_box);
        (*delegate).set_ivar("toolbar", cocoa::base::nil);
        (*delegate).set_ivar("super_delegate", current_delegate);

        ns_win_id.setDelegate_(delegate)
    }
}
