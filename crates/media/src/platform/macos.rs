use cidre::{cg, cv};
use cocoa::{base::id, foundation::NSDictionary};
use core_foundation::{
    array::CFArrayGetCount,
    base::FromVoid,
    dictionary::CFDictionaryGetValue,
    number::{CFNumberGetValue, CFNumberRef, kCFNumberIntType},
    string::{CFString, CFStringRef},
};
use core_graphics::{
    base::boolean_t,
    display::{CFArrayGetValueAtIndex, CFDictionaryRef, CGDisplay, CGDisplayBounds, CGRect},
    window::{
        CGWindowListCopyWindowInfo, kCGNullWindowID, kCGWindowBounds, kCGWindowLayer,
        kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowName,
        kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID,
    },
};
use std::{collections::HashMap, ffi::c_void};

use crate::platform::{Bounds, LogicalPosition, LogicalSize, Window};

use super::LogicalBounds;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
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
    let value_ref = unsafe { CFDictionaryGetValue(cf_dictionary_ref, key as *const c_void) };
    if value_ref.is_null() {
        return None;
    }

    Some(value_ref)
}

unsafe fn get_number_value_from_dict(
    cf_dictionary_ref: CFDictionaryRef,
    key: CFStringRef,
) -> Option<u32> {
    unsafe { get_nullable_value_from_dict(cf_dictionary_ref, key) }.and_then(|value_ref| {
        let mut value: u32 = 0;
        let value_ptr = &mut value as *mut _ as *mut c_void;
        match unsafe { CFNumberGetValue(value_ref as CFNumberRef, kCFNumberIntType, value_ptr) } {
            true => Some(value),
            false => None,
        }
    })
}

unsafe fn get_string_value_from_dict(
    cf_dictionary_ref: CFDictionaryRef,
    key: CFStringRef,
) -> Option<String> {
    unsafe { get_nullable_value_from_dict(cf_dictionary_ref, key) }
        .map(|value_ref| unsafe { CFString::from_void(value_ref).to_string() })
}

fn get_window_bounds(window_cf_dictionary_ref: CFDictionaryRef) -> Option<Bounds> {
    unsafe { get_nullable_value_from_dict(window_cf_dictionary_ref, kCGWindowBounds) }.map(
        |value_ref| {
            let rect: CGRect = {
                let mut rect = unsafe { std::mem::zeroed() };
                unsafe { CGRectMakeWithDictionaryRepresentation(value_ref.cast(), &mut rect) };
                rect
            };

            Bounds {
                x: rect.origin.x,
                y: rect.origin.y,
                width: rect.size.width,
                height: rect.size.height,
            }
        },
    )
}

pub fn bring_window_to_focus(window_id: u32) {
    // TODO(PJ): Replace with Accessibility API once I remember how it works
    use std::io::Write;
    use std::process::Command;
    use tempfile::NamedTempFile;

    println!("Attempting to bring window {window_id} to focus");

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
                    eprintln!("AppleScript execution failed: {error_message}");
                }
            }
            Err(e) => eprintln!("Failed to execute AppleScript: {e}"),
        }

        println!("Finished attempt to bring window {window_id} to focus");
    } else {
        eprintln!("Window with id {window_id} not found");
    }
}

pub fn display_names() -> HashMap<u32, String> {
    use cocoa::appkit::NSScreen;
    use cocoa::base::nil;
    use cocoa::foundation::{NSArray, NSString};
    use objc::{msg_send, *};
    use std::ffi::CStr;

    unsafe {
        let screens = NSScreen::screens(nil);
        let screen_count = NSArray::count(screens);

        let mut names = HashMap::new();

        for i in 0..screen_count {
            let screen: *mut objc::runtime::Object = screens.objectAtIndex(i);

            let name: id = msg_send![screen, localizedName];
            let name = CStr::from_ptr(NSString::UTF8String(name))
                .to_string_lossy()
                .to_string();

            let device_description = NSScreen::deviceDescription(screen);
            let num = NSDictionary::valueForKey_(
                device_description,
                NSString::alloc(nil).init_str("NSScreenNumber"),
            ) as id;
            let num: *const objc2_foundation::NSNumber = num.cast();
            let num = { &*num };
            let num = num.as_u32();

            names.insert(num, name);
        }

        names
    }
}

pub fn monitor_bounds(id: u32) -> Bounds {
    use cocoa::appkit::NSScreen;
    use cocoa::base::nil;
    use cocoa::foundation::{NSArray, NSDictionary, NSString};

    unsafe {
        let screens = NSScreen::screens(nil);
        let screen_count = NSArray::count(screens);

        for i in 0..screen_count {
            let screen: *mut objc::runtime::Object = screens.objectAtIndex(i);

            let device_description = NSScreen::deviceDescription(screen);
            let num = NSDictionary::valueForKey_(
                device_description,
                NSString::alloc(nil).init_str("NSScreenNumber"),
            ) as id;
            let num: *const objc2_foundation::NSNumber = num.cast();
            let num = { &*num };
            let num = num.as_u32();

            if num == id {
                let frame = NSScreen::frame(screen);

                return Bounds {
                    x: frame.origin.x,
                    y: frame.origin.y,
                    width: frame.size.width,
                    height: frame.size.height,
                };
            }
        }

        Bounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        }
    }
}

pub fn get_display_refresh_rate(
    display_id: core_graphics::display::CGDirectDisplayID,
) -> Result<u32, String> {
    use core_graphics::display::CGDisplay;

    let display = CGDisplay::new(display_id);
    let rate = display
        .display_mode()
        .ok_or("no display_mode")?
        .refresh_rate()
        .round() as u32;

    if rate == 0 {
        // adapted from https://github.com/mpv-player/mpv/commit/eacf22e42a6bbce8a32e64f5563ac431122c1186
        let link = cv::DisplayLink::with_cg_display(cg::DirectDisplayId(display.id))
            .map_err(|e| format!("with_cg_display / {e}"))?;

        let t = link.nominal_output_video_refresh_period();

        if !t.flags.contains(cv::TimeFlags::IS_INDEFINITE) {
            Ok((t.scale as f64 / t.value as f64).round() as u32)
        } else {
            Err("refresh rate is indefinite".to_string())
        }
    } else {
        Ok(rate)
    }
}

pub fn display_for_window(
    window: core_graphics::window::CGWindowID,
) -> Option<core_graphics::display::CGDisplay> {
    use core_foundation::array::CFArray;
    use core_graphics::{
        display::{CFDictionary, CGDisplay, CGRect},
        window::{create_description_from_array, kCGWindowBounds},
    };

    let descriptions = create_description_from_array(CFArray::from_copyable(&[window]))?;

    let window_bounds = CGRect::from_dict_representation(
        &descriptions
            .get(0)?
            .get(unsafe { kCGWindowBounds })
            .downcast::<CFDictionary>()?,
    )?;

    for id in CGDisplay::active_displays().ok()? {
        let display = CGDisplay::new(id);
        if window_bounds.is_intersects(&display.bounds()) {
            return Some(display);
        }
    }

    None
}

pub fn primary_monitor_bounds() -> Bounds {
    let display = CGDisplay::main();
    let height = display.pixels_high();
    let width = display.pixels_wide();
    let bounds = unsafe { CGDisplayBounds(display.id) };

    Bounds {
        x: bounds.origin.x,
        y: bounds.origin.y,
        width: width as f64,
        height: height as f64,
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MonitorHandle(pub u32);

impl MonitorHandle {
    pub fn primary() -> Self {
        let display = CGDisplay::main();
        Self(display.id)
    }

    pub fn list_all() -> Vec<Self> {
        use cocoa::appkit::NSScreen;
        use cocoa::base::nil;
        use cocoa::foundation::{NSArray, NSDictionary, NSString};

        let mut ret = vec![];

        unsafe {
            let screens = NSScreen::screens(nil);
            let screen_count = NSArray::count(screens);

            for i in 0..screen_count {
                let screen: *mut objc::runtime::Object = screens.objectAtIndex(i);

                let device_description = NSScreen::deviceDescription(screen);
                let num = NSDictionary::valueForKey_(
                    device_description,
                    NSString::alloc(nil).init_str("NSScreenNumber"),
                ) as id;
                let num: *const objc2_foundation::NSNumber = num.cast();
                let num = { &*num };
                let num = num.as_u32();

                ret.push(Self(num));
            }

            ret
        }
    }
}

pub fn logical_monitor_bounds(monitor_id: u32) -> Option<LogicalBounds> {
    use cocoa::appkit::NSScreen;
    use cocoa::base::nil;
    use cocoa::foundation::{NSArray, NSDictionary, NSString};

    unsafe {
        let screens = NSScreen::screens(nil);
        let screen_count = NSArray::count(screens);

        for i in 0..screen_count {
            let screen: *mut objc::runtime::Object = screens.objectAtIndex(i);

            let device_description = NSScreen::deviceDescription(screen);
            let num = NSDictionary::valueForKey_(
                device_description,
                NSString::alloc(nil).init_str("NSScreenNumber"),
            ) as id;
            let num: *const objc2_foundation::NSNumber = num.cast();
            let num = { &*num };
            let num = num.as_u32();

            if num == monitor_id {
                let frame = NSScreen::frame(screen);

                return Some(LogicalBounds {
                    position: LogicalPosition {
                        x: frame.origin.x,
                        y: frame.origin.y
                            + (CGDisplay::main().pixels_high() as f64 - frame.size.height),
                    },
                    size: LogicalSize {
                        width: frame.size.width,
                        height: frame.size.height,
                    },
                });
            }
        }

        None
    }
}
