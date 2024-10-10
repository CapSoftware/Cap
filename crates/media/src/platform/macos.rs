use core_foundation::{
    array::CFArrayGetCount,
    base::FromVoid,
    dictionary::CFDictionaryGetValue,
    number::{kCFNumberIntType, CFNumberGetValue, CFNumberRef},
    string::{CFString, CFStringRef},
};
use core_graphics::{
    base::boolean_t,
    display::{CFArrayGetValueAtIndex, CFDictionaryRef, CGRect},
    window::{
        kCGNullWindowID, kCGWindowBounds, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly, kCGWindowName, kCGWindowNumber, kCGWindowOwnerName,
        kCGWindowOwnerPID, CGWindowListCopyWindowInfo,
    },
};
use std::ffi::c_void;

use crate::platform::{Bounds, Window};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGRectMakeWithDictionaryRepresentation(
        dict: CFDictionaryRef,
        rect: *mut CGRect,
    ) -> boolean_t;
}

pub fn get_on_screen_windows() -> Vec<Window> {
    let mut windows = Vec::new();

    unsafe {
        let cf_win_array = CGWindowListCopyWindowInfo(
            kCGWindowListExcludeDesktopElements | kCGWindowListOptionOnScreenOnly,
            kCGNullWindowID,
        );

        let window_count = match cf_win_array.is_null() {
            true => 0,
            false => CFArrayGetCount(cf_win_array),
        };

        for i in 0..window_count {
            let window_cf_dictionary_ref =
                CFArrayGetValueAtIndex(cf_win_array, i) as CFDictionaryRef;

            if window_cf_dictionary_ref.is_null() {
                continue;
            }

            let level = match get_number_value_from_dict(window_cf_dictionary_ref, kCGWindowLayer) {
                Some(value) => value,
                None => continue,
            };

            let window_id =
                match get_number_value_from_dict(window_cf_dictionary_ref, kCGWindowNumber) {
                    Some(value) => value,
                    None => continue,
                };

            let name = match get_string_value_from_dict(window_cf_dictionary_ref, kCGWindowName) {
                Some(value) => value,
                None => continue,
            };

            let owner_name =
                match get_string_value_from_dict(window_cf_dictionary_ref, kCGWindowOwnerName) {
                    Some(value) => value,
                    None => continue,
                };

            if owner_name != "Window Server" && level == 0 && !name.is_empty() {
                let process_id =
                    match get_number_value_from_dict(window_cf_dictionary_ref, kCGWindowOwnerPID) {
                        Some(value) => value,
                        None => continue,
                    };
                if let Some(bounds) = get_window_bounds(window_cf_dictionary_ref) {
                    windows.push(Window {
                        window_id,
                        name,
                        owner_name,
                        process_id,
                        bounds,
                    });
                }
            }
        }
    }

    windows
}

unsafe fn get_nullable_value_from_dict(
    cf_dictionary_ref: CFDictionaryRef,
    key: CFStringRef,
) -> Option<*const c_void> {
    let value_ref = CFDictionaryGetValue(cf_dictionary_ref, key as *const c_void);
    if value_ref.is_null() {
        return None;
    }

    Some(value_ref)
}

unsafe fn get_number_value_from_dict(
    cf_dictionary_ref: CFDictionaryRef,
    key: CFStringRef,
) -> Option<u32> {
    get_nullable_value_from_dict(cf_dictionary_ref, key).and_then(|value_ref| {
        let mut value: u32 = 0;
        let value_ptr = &mut value as *mut _ as *mut c_void;
        match CFNumberGetValue(value_ref as CFNumberRef, kCFNumberIntType, value_ptr) {
            true => Some(value),
            false => None,
        }
    })
}

unsafe fn get_string_value_from_dict(
    cf_dictionary_ref: CFDictionaryRef,
    key: CFStringRef,
) -> Option<String> {
    get_nullable_value_from_dict(cf_dictionary_ref, key)
        .map(|value_ref| CFString::from_void(value_ref).to_string())
}

unsafe fn get_window_bounds(window_cf_dictionary_ref: CFDictionaryRef) -> Option<Bounds> {
    get_nullable_value_from_dict(window_cf_dictionary_ref, kCGWindowBounds).map(|value_ref| {
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
    })
}
