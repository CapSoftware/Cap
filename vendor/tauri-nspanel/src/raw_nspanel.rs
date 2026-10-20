#![allow(deprecated)]

use bitflags::bitflags;
use cocoa::{
    appkit::{NSView, NSViewHeightSizable, NSViewWidthSizable, NSWindowCollectionBehavior},
    base::{id, nil, BOOL, YES},
    foundation::{NSRect, NSUInteger},
};
use objc::{
    class,
    declare::ClassDecl,
    msg_send,
    runtime::{self, Class, Object, Sel},
    sel, sel_impl, Message,
};
use objc_foundation::INSObject;
use objc_id::{Id, ShareId};
use tauri::{Runtime, WebviewWindow};

bitflags! {
    struct NSTrackingAreaOptions: u32 {
        const NSTrackingActiveAlways = 0x80;
        const NSTrackingMouseEnteredAndExited = 0x01;
        const NSTrackingMouseMoved = 0x02;
        const NSTrackingCursorUpdate = 0x04;
    }
}

extern "C" {
    pub fn object_setClass(obj: id, cls: id) -> id;
}

const CLS_NAME: &str = "RawNSPanel";

pub struct RawNSPanel;

unsafe impl Sync for RawNSPanel {}
unsafe impl Send for RawNSPanel {}

impl INSObject for RawNSPanel {
    fn class() -> &'static runtime::Class {
        Class::get(CLS_NAME).unwrap_or_else(Self::define_class)
    }
}

impl RawNSPanel {
    /// Returns YES to ensure that RawNSPanel can become a key window
    extern "C" fn can_become_key_window(_: &Object, _: Sel) -> BOOL {
        YES
    }

    // No `dealloc` override. The upstream plugin installed one that sent
    // `dealloc` straight to NSObject's implementation (skipping NSWindow's
    // teardown) and then jumped through the leftover return register as if it
    // were a function pointer, which is a bus error the moment a converted
    // window is ever freed. NSPanel's inherited dealloc chain is the correct
    // one; there is nothing panel-specific to clean up here.
    fn define_class() -> &'static Class {
        let mut cls = ClassDecl::new(CLS_NAME, class!(NSPanel))
            .unwrap_or_else(|| panic!("Unable to register {} class", CLS_NAME));

        unsafe {
            cls.add_method(
                sel!(canBecomeKeyWindow),
                Self::can_become_key_window as extern "C" fn(&Object, Sel) -> BOOL,
            );
        }

        cls.register()
    }

    /// Whether `object` has already been re-classed into a `RawNSPanel`.
    ///
    /// # Safety
    /// `object` must point to a live Objective-C object.
    pub unsafe fn is_raw_panel(object: id) -> bool {
        if object.is_null() {
            return false;
        }
        // `isKindOfClass:` rather than a pointer compare: once anything
        // observes the window with KVO, its class becomes a dynamic
        // `NSKVONotifying_RawNSPanel` subclass, and swapping the class again
        // from under KVO is exactly what breaks observer removal later.
        let is_kind: BOOL = msg_send![object, isKindOfClass: Self::class()];
        is_kind == YES
    }

    /// Runs `swap` with the window's content subviews (the webview) detached.
    ///
    /// WebKit observes its window with KVO from the moment the webview is
    /// added to it, and KVO implements that by giving the window a dynamic
    /// notifying subclass. Re-classing the window while those observers are
    /// registered discards that subclass, so when WebKit later removes its
    /// observers (window teardown) Foundation throws `NSRangeException`
    /// ("not registered as an observer"), which unwinds through tao's run-loop
    /// observer and aborts the process. Detaching the views first makes WebKit
    /// unregister against the old class and re-register against the panel.
    unsafe fn with_content_subviews_detached(nswindow: id, swap: impl FnOnce()) {
        let content_view: id = msg_send![nswindow, contentView];
        if content_view.is_null() {
            swap();
            return;
        }
        let subviews: id = msg_send![content_view, subviews];
        // Own a snapshot: removing views mutates the live array and would
        // otherwise drop the only references to them.
        let subviews: id = msg_send![subviews, copy];
        let count: NSUInteger = msg_send![subviews, count];
        let first_responder: id = msg_send![nswindow, firstResponder];
        for index in 0..count {
            let view: id = msg_send![subviews, objectAtIndex: index];
            let _: () = msg_send![view, removeFromSuperview];
        }

        swap();

        for index in 0..count {
            let view: id = msg_send![subviews, objectAtIndex: index];
            let _: () = msg_send![content_view, addSubview: view];
        }
        if !first_responder.is_null() {
            let is_view: BOOL = msg_send![first_responder, isKindOfClass: class!(NSView)];
            if is_view == YES {
                let in_window: id = msg_send![first_responder, window];
                if in_window == nswindow {
                    let _: BOOL = msg_send![nswindow, makeFirstResponder: first_responder];
                }
            }
        }
        let _: () = msg_send![subviews, release];
    }

    pub fn show(&self) {
        self.make_first_responder(Some(self.content_view()));
        self.order_front_regardless();
        self.make_key_window();
    }

    pub fn is_visible(&self) -> bool {
        let flag: BOOL = unsafe { msg_send![self, isVisible] };
        flag == YES
    }

    pub fn is_floating_panel(&self) -> bool {
        let flag: BOOL = unsafe { msg_send![self, isFloatingPanel] };
        flag == YES
    }

    pub fn make_key_window(&self) {
        let _: () = unsafe { msg_send![self, makeKeyWindow] };
    }

    pub fn resign_key_window(&self) {
        let _: () = unsafe { msg_send![self, resignKeyWindow] };
    }

    pub fn make_key_and_order_front(&self, sender: Option<id>) {
        let _: () = unsafe { msg_send![self, makeKeyAndOrderFront: sender.unwrap_or(nil)] };
    }

    pub fn order_front_regardless(&self) {
        let _: () = unsafe { msg_send![self, orderFrontRegardless] };
    }

    pub fn order_out(&self, sender: Option<id>) {
        let _: () = unsafe { msg_send![self, orderOut: sender.unwrap_or(nil)] };
    }

    pub fn content_view(&self) -> id {
        unsafe { msg_send![self, contentView] }
    }

    pub fn make_first_responder(&self, sender: Option<id>) {
        if let Some(responder) = sender {
            let _: () = unsafe { msg_send![self, makeFirstResponder: responder] };
        } else {
            let _: () = unsafe { msg_send![self, makeFirstResponder: self] };
        }
    }

    pub fn set_level(&self, level: i32) {
        let _: () = unsafe { msg_send![self, setLevel: level] };
    }

    pub fn set_alpha_value(&self, value: f64) {
        let _: () = unsafe { msg_send![self, setAlphaValue: value] };
    }

    pub fn set_content_size(&self, width: f64, height: f64) {
        let _: () = unsafe { msg_send![self, setContentSize: (width, height)] };
    }

    pub fn set_style_mask(&self, style_mask: i32) {
        let _: () = unsafe { msg_send![self, setStyleMask: style_mask] };
    }

    pub fn set_collection_behaviour(&self, behaviour: NSWindowCollectionBehavior) {
        let _: () = unsafe { msg_send![self, setCollectionBehavior: behaviour] };
    }

    pub fn set_delegate<T>(&self, delegate: Id<T>) {
        let _: () = unsafe { msg_send![self, setDelegate: delegate] };
    }

    pub fn set_floating_panel(&self, value: bool) {
        let _: () = unsafe { msg_send![self, setFloatingPanel: value] };
    }

    pub fn set_accepts_mouse_moved_events(&self, value: bool) {
        let _: () = unsafe { msg_send![self, setAcceptsMouseMovedEvents: value] };
    }

    pub fn set_ignore_mouse_events(&self, value: bool) {
        let _: () = unsafe { msg_send![self, setIgnoresMouseEvents: value] };
    }

    pub fn set_hides_on_deactivate(&self, value: bool) {
        let _: () = unsafe { msg_send![self, setHidesOnDeactivate: value] };
    }

    pub fn set_moveable_by_window_background(&self, value: bool) {
        let _: () = unsafe { msg_send![self, setMovableByWindowBackground: value] };
    }

    pub fn set_becomes_key_only_if_needed(&self, value: bool) {
        let _: () = unsafe { msg_send![self, setBecomesKeyOnlyIfNeeded: value] };
    }

    pub fn set_works_when_modal(&self, value: bool) {
        let _: () = unsafe { msg_send![self, setWorksWhenModal: value] };
    }

    pub fn set_opaque(&self, value: bool) {
        let _: () = unsafe { msg_send![self, setOpaque: value] };
    }

    pub fn set_has_shadow(&self, value: bool) {
        let _: () = unsafe { msg_send![self, setHasShadow: value] };
    }

    pub fn set_released_when_closed(&self, value: bool) {
        let _: () = unsafe { msg_send![self, setReleasedWhenClosed: value] };
    }

    #[deprecated(
        since = "2.0.1",
        note = "Use set_released_when_closed(bool) instead. This method will be removed in a future version."
    )]
    pub fn released_when_closed(&self, value: bool) {
        self.set_released_when_closed(value);
    }

    pub fn close(&self) {
        let _: () = unsafe { msg_send![self, close] };
    }

    pub fn handle(&mut self) -> ShareId<Self> {
        unsafe { ShareId::from_ptr(self as *mut Self) }
    }

    fn add_tracking_area(&self) {
        let view: id = self.content_view();
        let bounds: NSRect = unsafe { NSView::bounds(view) };
        let track_view: id = unsafe { msg_send![class!(NSTrackingArea), alloc] };
        let track_view: id = unsafe {
            msg_send![
            track_view,
            initWithRect: bounds
            options: NSTrackingAreaOptions::NSTrackingActiveAlways
            | NSTrackingAreaOptions::NSTrackingMouseEnteredAndExited
            | NSTrackingAreaOptions::NSTrackingMouseMoved
            | NSTrackingAreaOptions::NSTrackingCursorUpdate
            owner: view
            userInfo: nil
            ]
        };
        let autoresizing_mask = NSViewWidthSizable | NSViewHeightSizable;
        let () = unsafe { msg_send![view, setAutoresizingMask: autoresizing_mask] };
        let () = unsafe { msg_send![view, addTrackingArea: track_view] };
        // `alloc`/`init` handed us a +1 reference and the view now holds its
        // own; drop ours so the tracking area is released with the view.
        let () = unsafe { msg_send![track_view, release] };
    }

    /// Enables the webview (and any other subviews) to automatically resize with its parent window.
    pub fn auto_resize(&self) {
        let content_view: id = self.content_view();

        let subviews: id = unsafe { msg_send![content_view, subviews] };

        let count: NSUInteger = unsafe { msg_send![subviews, count] };

        for i in 0..count {
            let view: id = unsafe { msg_send![subviews, objectAtIndex: i] };

            if view.is_null() {
                continue;
            }

            let _: () = unsafe {
                msg_send![view, setAutoresizingMask: NSViewWidthSizable | NSViewHeightSizable]
            };
        }
    }

    /// Create an NSPanel from a Tauri Webview Window.
    ///
    /// The returned handle owns a retain of its own. Tao keeps its reference to
    /// the NSWindow untouched, so dropping this handle (or any clone of it) can
    /// never strip the runtime's ownership. Converting a window that is already
    /// a `RawNSPanel` is a no-op apart from taking that retain: the class swap,
    /// tracking area and autoresize setup only happen on the first conversion.
    pub fn from_window<R: Runtime>(window: WebviewWindow<R>) -> Id<Self> {
        let nswindow: id = window.ns_window().unwrap() as _;
        unsafe { Self::from_ns_window(nswindow) }
    }

    /// Re-class a live NSWindow into a `RawNSPanel` and take a retained handle
    /// to it. See [`RawNSPanel::from_window`] for the ownership contract.
    ///
    /// # Safety
    /// `nswindow` must point to a live NSWindow, and this must run on the main
    /// thread (AppKit requires it for the class swap and view mutations).
    pub unsafe fn from_ns_window(nswindow: id) -> Id<Self> {
        let already_panel = Self::is_raw_panel(nswindow);
        if !already_panel {
            Self::with_content_subviews_detached(nswindow, || {
                let nspanel_class: id = msg_send![Self::class(), class];
                object_setClass(nswindow, nspanel_class);
            });
        }

        // `from_ptr` retains: the plugin's handle is a real +1, not a claim on
        // the retain tao already holds (which is what `from_retained_ptr` did,
        // and what made every extra `to_panel()` an over-release).
        let panel = Id::from_ptr(nswindow as *mut RawNSPanel);

        if !already_panel {
            // Add a tracking area to the panel's content view,
            // so that we can receive mouse events such as mouseEntered and mouseExited
            panel.add_tracking_area();

            // Sets the webview to automatically grow and shrink its size and position when the parent window resizes.
            panel.auto_resize();
        }

        panel
    }
}

unsafe impl Message for RawNSPanel {}
