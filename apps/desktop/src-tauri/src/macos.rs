use std::ffi::c_void;

use core_graphics::{
    base::boolean_t,
    display::{CFDictionaryRef, CGRect},
    window::kCGWindowBounds,
};

#[derive(Debug)]
pub struct Window {
    pub window_number: u32,
    pub name: String,
    pub owner_name: String,
    pub level: u32,
    pub bounds: Bounds,
}

#[derive(Debug)]
pub struct Bounds {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

pub fn get_on_screen_windows() -> Vec<Window> {
    use std::ffi::c_void;

    use core_foundation::{
        array::CFArrayGetCount,
        base::FromVoid,
        dictionary::CFDictionaryGetValue,
        number::{kCFNumberIntType, CFNumberGetValue, CFNumberRef},
        string::CFString,
    };
    use core_graphics::{
        display::{CFArrayGetValueAtIndex, CFDictionaryRef},
        window::{
            kCGNullWindowID, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
            kCGWindowListOptionOnScreenOnly, kCGWindowName, kCGWindowNumber, kCGWindowOwnerName,
            CGWindowListCopyWindowInfo,
        },
    };

    let mut array = vec![];

    unsafe {
        let cf_win_array = CGWindowListCopyWindowInfo(
            kCGWindowListExcludeDesktopElements | kCGWindowListOptionOnScreenOnly,
            kCGNullWindowID,
        );

        if cf_win_array.is_null() {
            return array;
        }

        let count = CFArrayGetCount(cf_win_array);

        for i in 0..count {
            let window_cf_dictionary_ref =
                CFArrayGetValueAtIndex(cf_win_array, i) as CFDictionaryRef;

            if window_cf_dictionary_ref.is_null() {
                continue;
            }

            let level = {
                let level_ref =
                    CFDictionaryGetValue(window_cf_dictionary_ref, kCGWindowLayer as *const c_void);
                if level_ref.is_null() {
                    continue;
                }

                let mut value: u32 = 0;
                let is_success = CFNumberGetValue(
                    level_ref as CFNumberRef,
                    kCFNumberIntType,
                    &mut value as *mut _ as *mut c_void,
                );

                if !is_success {
                    continue;
                }

                value
            };

            let bounds = {
                let value_ref = CFDictionaryGetValue(
                    window_cf_dictionary_ref,
                    kCGWindowBounds as *const c_void,
                );
                if value_ref.is_null() {
                    continue;
                }

                let rect: CGRect = {
                    let mut rect = std::mem::zeroed();
                    CGRectMakeWithDictionaryRepresentation(value_ref.cast(), &mut rect);
                    rect
                };

                Bounds {
                    x: rect.origin.x as u32,
                    y: rect.origin.y as u32,
                    width: rect.size.width as u32,
                    height: rect.size.height as u32,
                }
            };

            let window_number = {
                let level_ref = CFDictionaryGetValue(
                    window_cf_dictionary_ref,
                    kCGWindowNumber as *const c_void,
                );
                if level_ref.is_null() {
                    continue;
                }

                let mut value: u32 = 0;
                let is_success = CFNumberGetValue(
                    level_ref as CFNumberRef,
                    kCFNumberIntType,
                    &mut value as *mut _ as *mut c_void,
                );

                if !is_success {
                    continue;
                }

                value
            };

            let name = {
                let value_ref =
                    CFDictionaryGetValue(window_cf_dictionary_ref, kCGWindowName as *const c_void);
                if value_ref.is_null() {
                    continue;
                }

                CFString::from_void(value_ref).to_string()
            };

            let owner_name = {
                let value_ref = CFDictionaryGetValue(
                    window_cf_dictionary_ref,
                    kCGWindowOwnerName as *const c_void,
                );
                if value_ref.is_null() {
                    continue;
                }

                CFString::from_void(value_ref).to_string()
            };

            if owner_name == "Window Server" {
                continue;
            }

            if level == 0 && !name.is_empty() {
                array.push(Window {
                    name,
                    owner_name,
                    window_number,
                    level,
                    bounds,
                });
            }
        }
    }

    array
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
