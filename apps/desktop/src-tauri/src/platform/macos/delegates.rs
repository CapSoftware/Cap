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
use objc::{msg_send, sel, sel_impl};
use rand::{distributions::Alphanumeric, Rng};
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
        appkit::{NSView, NSWindow, NSWindowButton},
        base::id,
        foundation::NSRect,
    };

    let ns_window = ns_window_handle.0 as id;
    unsafe {
        let close = ns_window.standardWindowButton_(NSWindowButton::NSWindowCloseButton);
        let minimize = ns_window.standardWindowButton_(NSWindowButton::NSWindowMiniaturizeButton);
        let zoom = ns_window.standardWindowButton_(NSWindowButton::NSWindowZoomButton);

        let title_bar_container_view = close.superview().superview();

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
    use cocoa::base::{id, BOOL};
    use cocoa::foundation::NSUInteger;
    use objc::runtime::{Object, Sel};
    use std::ffi::c_void;

    let ns_win = window.ns_window().expect("Failed to create window handle");

    // Do the initial positioning
    position_window_controls(UnsafeWindowHandle(ns_win), &controls_inset);

    // Ensure they stay in place while resizing the window.
    fn with_window_state<R: Runtime, F: FnOnce(&mut WindowState<R>) -> T, T>(
        this: &Object,
        func: F,
    ) {
        let ptr = unsafe {
            let x: *mut c_void = *this.get_ivar("app_box");
            &mut *(x as *mut WindowState<R>)
        };
        func(ptr);
    }

    unsafe {
        let ns_win_id = ns_win as id;
        let current_delegate: id = ns_win_id.delegate();

        extern "C" fn on_window_should_close(this: &Object, _cmd: Sel, sender: id) -> BOOL {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                msg_send![super_del, windowShouldClose: sender]
            }
        }
        extern "C" fn on_window_will_close(this: &Object, _cmd: Sel, notification: id) {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowWillClose: notification];
            }
        }
        extern "C" fn on_window_did_resize<R: Runtime>(this: &Object, _cmd: Sel, notification: id) {
            unsafe {
                with_window_state(this, |state: &mut WindowState<R>| {
                    position_window_controls(
                        UnsafeWindowHandle(
                            state
                                .window
                                .ns_window()
                                .expect("Failed to get handle to NSWindow"),
                        ),
                        &state.controls_inset,
                    );
                });

                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidResize: notification];
            }
        }
        extern "C" fn on_window_did_move(this: &Object, _cmd: Sel, notification: id) {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidMove: notification];
            }
        }
        extern "C" fn on_window_did_change_backing_properties(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidChangeBackingProperties: notification];
            }
        }
        extern "C" fn on_window_did_become_key(this: &Object, _cmd: Sel, notification: id) {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidBecomeKey: notification];
            }
        }
        extern "C" fn on_window_did_resign_key(this: &Object, _cmd: Sel, notification: id) {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidResignKey: notification];
            }
        }
        extern "C" fn on_dragging_entered(this: &Object, _cmd: Sel, notification: id) -> BOOL {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                msg_send![super_del, draggingEntered: notification]
            }
        }
        extern "C" fn on_prepare_for_drag_operation(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) -> BOOL {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                msg_send![super_del, prepareForDragOperation: notification]
            }
        }
        extern "C" fn on_perform_drag_operation(this: &Object, _cmd: Sel, sender: id) -> BOOL {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                msg_send![super_del, performDragOperation: sender]
            }
        }
        extern "C" fn on_conclude_drag_operation(this: &Object, _cmd: Sel, notification: id) {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, concludeDragOperation: notification];
            }
        }
        extern "C" fn on_dragging_exited(this: &Object, _cmd: Sel, notification: id) {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, draggingExited: notification];
            }
        }
        extern "C" fn on_window_will_use_full_screen_presentation_options(
            this: &Object,
            _cmd: Sel,
            window: id,
            proposed_options: NSUInteger,
        ) -> NSUInteger {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                msg_send![super_del, window: window willUseFullScreenPresentationOptions: proposed_options]
            }
        }
        extern "C" fn on_window_did_enter_full_screen<R: Runtime>(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) {
            unsafe {
                with_window_state(this, |state: &mut WindowState<R>| {
                    state
                        .window
                        .emit("did-enter-fullscreen", ())
                        .expect("Failed to emit event");
                });

                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidEnterFullScreen: notification];
            }
        }
        extern "C" fn on_window_will_enter_full_screen<R: Runtime>(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) {
            unsafe {
                with_window_state(this, |state: &mut WindowState<R>| {
                    state
                        .window
                        .emit("will-enter-fullscreen", ())
                        .expect("Failed to emit event");
                });

                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowWillEnterFullScreen: notification];
            }
        }
        extern "C" fn on_window_did_exit_full_screen<R: Runtime>(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) {
            unsafe {
                with_window_state(this, |state: &mut WindowState<R>| {
                    state
                        .window
                        .emit("did-exit-fullscreen", ())
                        .expect("Failed to emit event");

                    position_window_controls(
                        UnsafeWindowHandle(
                            state
                                .window
                                .ns_window()
                                .expect("Failed to get handle to NSWindow"),
                        ),
                        &state.controls_inset,
                    );
                });

                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidExitFullScreen: notification];
            }
        }
        extern "C" fn on_window_will_exit_full_screen<R: Runtime>(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) {
            unsafe {
                with_window_state(this, |state: &mut WindowState<R>| {
                    state
                        .window
                        .emit("will-exit-fullscreen", ())
                        .expect("Failed to emit event");
                });

                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowWillExitFullScreen: notification];
            }
        }
        extern "C" fn on_window_did_fail_to_enter_full_screen(
            this: &Object,
            _cmd: Sel,
            window: id,
        ) {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, windowDidFailToEnterFullScreen: window];
            }
        }
        extern "C" fn on_effective_appearance_did_change(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![super_del, effectiveAppearanceDidChange: notification];
            }
        }
        extern "C" fn on_effective_appearance_did_changed_on_main_thread(
            this: &Object,
            _cmd: Sel,
            notification: id,
        ) {
            unsafe {
                let super_del: id = *this.get_ivar("super_delegate");
                let _: () = msg_send![
                    super_del,
                    effectiveAppearanceDidChangedOnMainThread: notification
                ];
            }
        }

        let window_label = window.label().to_string();

        let app_state = WindowState {
            window,
            controls_inset,
        };
        let app_box = Box::into_raw(Box::new(app_state)) as *mut c_void;
        let random_str: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(20)
            .map(char::from)
            .collect();

        // We need to ensure we have a unique delegate name, otherwise we will panic while trying to create a duplicate
        // delegate with the same name.
        let delegate_name = format!("windowDelegate_cap_{}_{}", window_label, random_str);

        ns_win_id.setDelegate_(cocoa::delegate!(&delegate_name, {
            window: id = ns_win_id,
            app_box: *mut c_void = app_box,
            toolbar: id = cocoa::base::nil,
            super_delegate: id = current_delegate,
            (windowShouldClose:) => on_window_should_close as extern fn(&Object, Sel, id) -> BOOL,
            (windowWillClose:) => on_window_will_close as extern fn(&Object, Sel, id),
            (windowDidResize:) => on_window_did_resize::<R> as extern fn(&Object, Sel, id),
            (windowDidMove:) => on_window_did_move as extern fn(&Object, Sel, id),
            (windowDidChangeBackingProperties:) => on_window_did_change_backing_properties as extern fn(&Object, Sel, id),
            (windowDidBecomeKey:) => on_window_did_become_key as extern fn(&Object, Sel, id),
            (windowDidResignKey:) => on_window_did_resign_key as extern fn(&Object, Sel, id),
            (draggingEntered:) => on_dragging_entered as extern fn(&Object, Sel, id) -> BOOL,
            (prepareForDragOperation:) => on_prepare_for_drag_operation as extern fn(&Object, Sel, id) -> BOOL,
            (performDragOperation:) => on_perform_drag_operation as extern fn(&Object, Sel, id) -> BOOL,
            (concludeDragOperation:) => on_conclude_drag_operation as extern fn(&Object, Sel, id),
            (draggingExited:) => on_dragging_exited as extern fn(&Object, Sel, id),
            (window:willUseFullScreenPresentationOptions:) => on_window_will_use_full_screen_presentation_options as extern fn(&Object, Sel, id, NSUInteger) -> NSUInteger,
            (windowDidEnterFullScreen:) => on_window_did_enter_full_screen::<R> as extern fn(&Object, Sel, id),
            (windowWillEnterFullScreen:) => on_window_will_enter_full_screen::<R> as extern fn(&Object, Sel, id),
            (windowDidExitFullScreen:) => on_window_did_exit_full_screen::<R> as extern fn(&Object, Sel, id),
            (windowWillExitFullScreen:) => on_window_will_exit_full_screen::<R> as extern fn(&Object, Sel, id),
            (windowDidFailToEnterFullScreen:) => on_window_did_fail_to_enter_full_screen as extern fn(&Object, Sel, id),
            (effectiveAppearanceDidChange:) => on_effective_appearance_did_change as extern fn(&Object, Sel, id),
            (effectiveAppearanceDidChangedOnMainThread:) => on_effective_appearance_did_changed_on_main_thread as extern fn(&Object, Sel, id)
        }))
    }
}
