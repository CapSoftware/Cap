use cocoa::base::id;
use core_foundation::{
    base::{FromVoid, TCFType},
    dictionary::CFDictionary,
    number::CFNumber,
    string::CFString,
};
use core_graphics::{
    display::{CGDisplay, CGDisplayBounds},
    window::{
        copy_window_info, kCGNullWindowID, kCGWindowBounds, kCGWindowLayer,
        kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
    },
};
use objc::rc::autoreleasepool;
use objc::{class, msg_send, sel, sel_impl};
use std::{panic::AssertUnwindSafe, str::FromStr};

use scap_targets::DisplayId;

pub mod delegates;
mod sc_shareable_content;

pub use sc_shareable_content::*;

fn frontmost_app_pid() -> Option<i32> {
    autoreleasepool(|| {
        objc2::exception::catch(AssertUnwindSafe(|| unsafe {
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return None;
            }
            let app: id = msg_send![workspace, frontmostApplication];
            if app.is_null() {
                return None;
            }
            let pid: i32 = msg_send![app, processIdentifier];
            Some(pid)
        }))
        .ok()
        .flatten()
    })
}

pub fn frontmost_display_id() -> Option<DisplayId> {
    let pid = frontmost_app_pid()?;
    if pid == std::process::id() as i32 {
        return None;
    }

    let windows = copy_window_info(
        kCGWindowListExcludeDesktopElements | kCGWindowListOptionOnScreenOnly,
        kCGNullWindowID,
    )?;

    let key_owner_pid = CFString::from_static_string("kCGWindowOwnerPID");
    let key_x = CFString::from_static_string("X");
    let key_y = CFString::from_static_string("Y");
    let key_width = CFString::from_static_string("Width");
    let key_height = CFString::from_static_string("Height");

    for window in windows.iter() {
        let window_dict =
            unsafe { CFDictionary::<CFString, *const std::ffi::c_void>::from_void(*window) };

        let owner_pid = unsafe {
            window_dict
                .find(key_owner_pid.as_concrete_TypeRef())
                .and_then(|v| CFNumber::from_void(*v).to_i32())
        };
        if owner_pid != Some(pid) {
            continue;
        }

        let layer = unsafe {
            window_dict
                .find(kCGWindowLayer)
                .and_then(|v| CFNumber::from_void(*v).to_i32())
        };
        if layer != Some(0) {
            continue;
        }

        let bounds_dict = unsafe {
            window_dict
                .find(kCGWindowBounds)
                .map(|v| CFDictionary::<CFString, *const std::ffi::c_void>::from_void(*v))
        }?;

        let x = unsafe {
            bounds_dict
                .find(key_x.as_concrete_TypeRef())
                .and_then(|v| CFNumber::from_void(*v).to_f64())
        }?;
        let y = unsafe {
            bounds_dict
                .find(key_y.as_concrete_TypeRef())
                .and_then(|v| CFNumber::from_void(*v).to_f64())
        }?;
        let width = unsafe {
            bounds_dict
                .find(key_width.as_concrete_TypeRef())
                .and_then(|v| CFNumber::from_void(*v).to_f64())
        }?;
        let height = unsafe {
            bounds_dict
                .find(key_height.as_concrete_TypeRef())
                .and_then(|v| CFNumber::from_void(*v).to_f64())
        }?;

        if width <= 0.0 || height <= 0.0 {
            continue;
        }

        let center_x = x + width / 2.0;
        let center_y = y + height / 2.0;

        if let Ok(displays) = CGDisplay::active_displays() {
            for display_id in displays {
                let bounds = unsafe { CGDisplayBounds(display_id) };
                if center_x >= bounds.origin.x
                    && center_x < bounds.origin.x + bounds.size.width
                    && center_y >= bounds.origin.y
                    && center_y < bounds.origin.y + bounds.size.height
                {
                    return DisplayId::from_str(&display_id.to_string()).ok();
                }
            }
        }

        break;
    }

    None
}

pub fn set_window_level(window: tauri::Window, level: objc2_app_kit::NSWindowLevel) {
    let c_window = window.clone();
    let label = window.label().to_string();
    _ = window.run_on_main_thread(move || unsafe {
        _ = objc2::exception::catch(std::panic::AssertUnwindSafe(|| {
            let Ok(ns_win) = c_window.ns_window() else {
                tracing::warn!("Failed to get NSWindow for {}", label);
                return;
            };
            let ns_win = ns_win as *const objc2_app_kit::NSWindow;
            tracing::info!("Setting window level for {} to {}", label, level);
            (*ns_win).setLevel(level);
        }));
    });
}

// pub fn get_ns_window_number(ns_window: *mut c_void) -> isize {
//     let ns_window = ns_window as *const objc2_app_kit::NSWindow;

//     unsafe { (*ns_window).windowNumber() }
// }

// #[link(name = "CoreGraphics", kind = "framework")]
// unsafe extern "C" {
//     pub fn CGRectMakeWithDictionaryRepresentation(
//         dict: CFDictionaryRef,
//         rect: *mut CGRect,
//     ) -> boolean_t;
// }

// /// Makes the background of the WKWebView layer transparent.
// /// This differs from Tauri's implementation as it does not change the window background which causes performance performance issues and artifacts when shadows are enabled on the window.
// /// Use Tauri's implementation to make the window itself transparent.
// pub fn make_webview_transparent(target: &tauri::WebviewWindow) -> tauri::Result<()> {
//     target.with_webview(|webview| unsafe {
//         let wkwebview = webview.inner() as id;
//         let no: id = msg_send![class!(NSNumber), numberWithBool:0];
//         // [https://developer.apple.com/documentation/webkit/webview/1408486-drawsbackground]
//         let _: id = msg_send![wkwebview, setValue:no forKey: NSString::alloc(nil).init_str("drawsBackground")];
//     })
// }
