use std::ffi::c_void;

use cocoa::{
    appkit::NSColor,
    base::{id, nil},
    foundation::NSString,
};
use core_graphics::{
    base::boolean_t,
    display::{CFDictionaryRef, CGRect},
    window::{kCGWindowBounds, kCGWindowOwnerPID},
};
use objc::{class, msg_send, sel, sel_impl};

pub mod delegates;

#[derive(Debug)]
pub struct Window {
    pub window_number: u32,
    pub name: String,
    pub owner_name: String,
    pub process_id: u32,
    pub bounds: Bounds,
}

#[derive(Debug)]
pub struct Bounds {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

pub fn set_window_level(window: tauri::Window, level: u32) {
    let c_window = window.clone();
    window.run_on_main_thread(move || unsafe {
        let ns_win = c_window
            .ns_window()
            .expect("Failed to get native window handle") as cocoa::base::id;
        let _: () = msg_send![ns_win, setLevel: level];
    });
}

pub fn get_ns_window_number(ns_window: *mut c_void) -> isize {
    let ns_window = ns_window as *const objc2_app_kit::NSWindow;

    unsafe { (*ns_window).windowNumber() }
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    pub fn CGRectMakeWithDictionaryRepresentation(
        dict: CFDictionaryRef,
        rect: *mut CGRect,
    ) -> boolean_t;
}

pub fn write_string_to_pasteboard(string: &str) {
    use cocoa::appkit::NSPasteboard;
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSArray, NSString};
    use objc::rc::autoreleasepool;

    unsafe {
        autoreleasepool(|| {
            let pasteboard: id = NSPasteboard::generalPasteboard(nil);
            NSPasteboard::clearContents(pasteboard);
            let ns_string = NSString::alloc(nil).init_str(string);
            let objects: id = NSArray::arrayWithObject(nil, ns_string);
            NSPasteboard::writeObjects(pasteboard, objects);
        });
    }
}

/// Makes the background of the WKWebView layer transparent.
/// This differs from Tauri's implementation as it does not change the window background which causes performance performance issues and artifacts when shadows are enabled on the window.
/// Use Tauri's implementation to make the window itself transparent.
pub fn make_webview_transparent(target: &tauri::WebviewWindow) -> tauri::Result<()> {
    target.with_webview(|webview| unsafe {
        let wkwebview = webview.inner() as id;
        let no: id = msg_send![class!(NSNumber), numberWithBool:0];
        // [https://developer.apple.com/documentation/webkit/webview/1408486-drawsbackground]
        let _: id = msg_send![wkwebview, setValue:no forKey: NSString::alloc(nil).init_str("drawsBackground")];
    })
}
