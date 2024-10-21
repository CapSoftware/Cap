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
pub use nokhwa_bindings_macos::{AVAuthorizationStatus, AVMediaType};
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
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height,
        }
    })
}

pub fn bring_window_to_focus(window_id: u32) {
    // TODO(PJ): Replace with Accessibility API once I remember how it works
    use std::io::Write;
    use std::process::Command;
    use tempfile::NamedTempFile;

    println!("Attempting to bring window {} to focus", window_id);

    // Get the window information associated with the window id
    let windows = get_on_screen_windows();
    if let Some(window) = windows.into_iter().find(|w| w.window_id == window_id) {
        let process_id = window.process_id;
        let window_title = window.name.clone();
        let bounds_x = window.bounds.x;
        let bounds_y = window.bounds.y;
        let bounds_width = window.bounds.width;
        let bounds_height = window.bounds.height;
        let should_focus = true;

        // Prepare the AppleScript
        let apple_script = r#"
        on run argv
            set processId to item 1 of argv as number
            set windowTitle to item 2 of argv
            set boundsX to item 3 of argv as number
            set boundsY to item 4 of argv as number
            set boundsWidth to item 5 of argv as number
            set boundsHeight to item 6 of argv as number
            set shouldFocus to item 7 of argv as boolean or true

            log "processId: " & processId
            log "windowTitle: " & windowTitle
            log "boundsX: " & boundsX
            log "boundsY: " & boundsY
            log "boundsWidth: " & boundsWidth
            log "boundsHeight: " & boundsHeight

            tell application "System Events"
                set appProcess to first process whose unix id is processId
                set frontmost of appProcess to true

                tell appProcess
                    set appWindowsCount to count of windows
                    log "appWindowsCount: " & appWindowsCount

                    if appWindowsCount is equal to 1 then
                        perform action "AXRaise" of first window
                        log "--found window--"
                        return
                    end if

                    repeat with checkedWindow in windows
                        tell checkedWindow
                            if title contains windowTitle and position is equal to {boundsX, boundsY} and size is equal to {boundsWidth, boundsHeight} then
                                perform action "AXRaise" of checkedWindow
                                log "--found window--"
                                exit repeat
                            end if
                        end tell
                    end repeat
                end tell
            end tell
        end run
        "#;

        // Prepare arguments
        let args = vec![
            process_id.to_string(),
            window_title.clone(),
            bounds_x.to_string(),
            bounds_y.to_string(),
            bounds_width.to_string(),
            bounds_height.to_string(),
            should_focus.to_string(),
        ];

        // Write the AppleScript to a temporary file
        let mut script_file = NamedTempFile::new().expect("Failed to create temp file");
        script_file
            .write_all(apple_script.as_bytes())
            .expect("Failed to write to temp file");

        // Execute the AppleScript with arguments
        let output = Command::new("osascript")
            .arg(script_file.path())
            .args(&args)
            .output();

        match output {
            Ok(output) => {
                if output.status.success() {
                    println!("Successfully executed AppleScript");
                } else {
                    let error_message = String::from_utf8_lossy(&output.stderr);
                    eprintln!("AppleScript execution failed: {}", error_message);
                }
            }
            Err(e) => eprintln!("Failed to execute AppleScript: {}", e),
        }

        println!("Finished attempt to bring window {} to focus", window_id);
    } else {
        eprintln!("Window with id {} not found", window_id);
    }
}
