use std::ffi::c_void;

use cocoa::{
    base::{id, nil},
    foundation::NSString,
};
use core_graphics::{
    base::boolean_t,
    display::{CFDictionaryRef, CGRect},
};
use objc::{class, msg_send, sel, sel_impl};

pub mod delegates;

pub fn set_window_level(window: tauri::Window, level: objc2_app_kit::NSWindowLevel) {
    let c_window = window.clone();
    _ = window.run_on_main_thread(move || unsafe {
        let ns_win = c_window
            .ns_window()
            .expect("Failed to get native window handle")
            as *const objc2_app_kit::NSWindow;
        (*ns_win).setLevel(level);
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
