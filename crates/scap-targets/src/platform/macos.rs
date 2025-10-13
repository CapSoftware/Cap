use std::{ffi::c_void, str::FromStr};

use cidre::{arc, ns, sc};
use cocoa::appkit::NSScreen;
use core_foundation::{
    array::CFArray,
    base::{FromVoid, TCFType},
    number::CFNumber,
    string::CFString,
};
use core_graphics::{
    display::{
        CFDictionary, CGDirectDisplayID, CGDisplay, CGDisplayBounds, CGDisplayCopyDisplayMode,
        CGRect, kCGWindowListOptionIncludingWindow,
    },
    window::{
        CGWindowID, kCGWindowBounds, kCGWindowLayer, kCGWindowName, kCGWindowNumber,
        kCGWindowOwnerName,
    },
};

use crate::bounds::{LogicalBounds, LogicalPosition, LogicalSize, PhysicalSize};

#[derive(Clone, Copy)]
pub struct DisplayImpl(CGDisplay);

impl DisplayImpl {
    pub fn primary() -> Self {
        Self(CGDisplay::main())
    }

    pub fn list() -> Vec<Self> {
        CGDisplay::active_displays()
            .into_iter()
            .flatten()
            .map(|v| Self(CGDisplay::new(v)))
            .collect()
    }

    pub fn inner(&self) -> CGDisplay {
        self.0
    }

    pub fn raw_id(&self) -> DisplayIdImpl {
        DisplayIdImpl(self.0.id)
    }

    pub fn from_id(id: String) -> Option<Self> {
        let parsed_id = id.parse::<u32>().ok()?;
        Self::list().into_iter().find(|d| d.0.id == parsed_id)
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        let rect = unsafe { CGDisplayBounds(self.0.id) };

        Some(LogicalSize {
            width: rect.size.width,
            height: rect.size.height,
        })
    }

    pub fn logical_position(&self) -> LogicalPosition {
        let rect = unsafe { CGDisplayBounds(self.0.id) };

        LogicalPosition {
            x: rect.origin.x,
            y: rect.origin.y,
        }
    }

    pub fn logical_bounds(&self) -> Option<LogicalBounds> {
        Some(LogicalBounds {
            position: self.logical_position(),
            size: self.logical_size()?,
        })
    }

    pub fn get_containing_cursor() -> Option<Self> {
        let cursor = get_cursor_position()?;

        Self::list().into_iter().find(|display| {
            let Some(logical_size) = display.logical_size() else {
                return false;
            };

            let bounds = LogicalBounds {
                position: display.logical_position(),
                size: logical_size,
            };
            bounds.contains_point(cursor)
        })
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        let mode = unsafe { CGDisplayCopyDisplayMode(self.0.id) };
        if mode.is_null() {
            return None;
        }

        let width = unsafe { core_graphics::display::CGDisplayModeGetPixelWidth(mode) };
        let height = unsafe { core_graphics::display::CGDisplayModeGetPixelHeight(mode) };

        unsafe { core_graphics::display::CGDisplayModeRelease(mode) };

        Some(PhysicalSize {
            width: width as f64,
            height: height as f64,
        })
    }

    pub fn scale(&self) -> Option<f64> {
        Some(unsafe { NSScreen::backingScaleFactor(self.as_ns_screen()?) })
    }

    pub fn refresh_rate(&self) -> f64 {
        let mode = unsafe { CGDisplayCopyDisplayMode(self.0.id) };
        if mode.is_null() {
            return 0.0;
        }

        let refresh_rate = unsafe { core_graphics::display::CGDisplayModeGetRefreshRate(mode) };

        unsafe { core_graphics::display::CGDisplayModeRelease(mode) };

        refresh_rate
    }

    pub fn name(&self) -> Option<String> {
        use cocoa::base::id;
        use cocoa::foundation::NSString;
        use objc::{msg_send, *};
        use std::ffi::CStr;

        unsafe {
            if let Some(ns_screen) = self.as_ns_screen() {
                let name: id = msg_send![ns_screen, localizedName];
                if !name.is_null() {
                    let name = CStr::from_ptr(NSString::UTF8String(name))
                        .to_string_lossy()
                        .to_string();
                    return Some(name);
                }
            }
        }

        None
    }

    fn as_ns_screen(&self) -> Option<*mut objc::runtime::Object> {
        use cocoa::appkit::NSScreen;
        use cocoa::base::{id, nil};
        use cocoa::foundation::{NSArray, NSDictionary, NSString};
        use objc::{msg_send, *};

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

                let num_value: u32 = msg_send![num, unsignedIntValue];

                if num_value == self.0.id {
                    return Some(screen);
                }
            }
        }

        None
    }
}

impl DisplayImpl {
    pub async fn as_sc(
        &self,
        content: arc::R<sc::ShareableContent>,
    ) -> Option<arc::R<sc::Display>> {
        content
            .displays()
            .iter()
            .find(|display| display.display_id().0 == self.0.id)
            .map(|display| display.retained())
    }

    pub async fn as_content_filter(
        &self,
        content: arc::R<sc::ShareableContent>,
    ) -> Option<arc::R<sc::ContentFilter>> {
        self.as_content_filter_excluding_windows(content, vec![])
            .await
    }

    pub async fn as_content_filter_excluding_windows(
        &self,
        content: arc::R<sc::ShareableContent>,
        windows: Vec<arc::R<sc::Window>>,
    ) -> Option<arc::R<sc::ContentFilter>> {
        let display = content
            .displays()
            .iter()
            .find(|display| display.display_id().0 == self.0.id)
            .map(|display| display.retained())?;

        Some(sc::ContentFilter::with_display_excluding_windows(
            display.as_ref(),
            &ns::Array::from_slice_retained(&windows),
        ))
    }
}

fn get_cursor_position() -> Option<LogicalPosition> {
    let event_source = core_graphics::event_source::CGEventSource::new(
        core_graphics::event_source::CGEventSourceStateID::Private,
    )
    .ok()?;

    let event = core_graphics::event::CGEvent::new(event_source).ok()?;
    let location = event.location();

    Some(LogicalPosition {
        x: location.x,
        y: location.y,
    })
}

#[derive(Clone, Copy)]
pub struct WindowImpl(CGWindowID);

impl WindowImpl {
    pub fn list() -> Vec<Self> {
        use core_graphics::window::{
            kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
        };

        let windows = core_graphics::window::copy_window_info(
            kCGWindowListExcludeDesktopElements | kCGWindowListOptionOnScreenOnly,
            kCGNullWindowID,
        );

        let Some(windows) = windows else {
            return vec![];
        };

        let mut ret = vec![];

        for window in windows.iter() {
            let window_dict =
                unsafe { CFDictionary::<CFString, *const c_void>::from_void(*window) };

            let Some(number) = (unsafe {
                window_dict
                    .find(kCGWindowNumber)
                    .and_then(|v| CFNumber::from_void(*v).to_i64().map(|v| v as u32))
            }) else {
                continue;
            };

            ret.push(WindowImpl(number));
        }

        ret
    }

    pub fn list_containing_cursor() -> Vec<Self> {
        let Some(cursor) = get_cursor_position() else {
            return vec![];
        };

        Self::list()
            .into_iter()
            .filter_map(|window| {
                let bounds = window.logical_bounds()?;
                bounds.contains_point(cursor).then_some(window)
            })
            .collect()
    }

    pub fn get_topmost_at_cursor() -> Option<Self> {
        let mut windows_with_level = Self::list_containing_cursor()
            .into_iter()
            .filter_map(|window| {
                let level = window.level()?;
                if level > 5 {
                    return None;
                }
                Some((window, level))
            })
            .collect::<Vec<_>>();

        windows_with_level.sort_by(|a, b| b.1.cmp(&a.1));

        windows_with_level.first().map(|(window, _)| *window)
    }

    pub fn id(&self) -> WindowIdImpl {
        WindowIdImpl(self.0)
    }

    pub fn level(&self) -> Option<i32> {
        let windows =
            core_graphics::window::copy_window_info(kCGWindowListOptionIncludingWindow, self.0)?;

        let window_dict =
            unsafe { CFDictionary::<CFString, *const c_void>::from_void(*windows.get(0)?) };

        unsafe {
            window_dict
                .find(kCGWindowLayer)
                .and_then(|v| CFNumber::from_void(*v).to_i32())
        }
    }

    pub fn owner_name(&self) -> Option<String> {
        let windows =
            core_graphics::window::copy_window_info(kCGWindowListOptionIncludingWindow, self.0)?;

        let window_dict =
            unsafe { CFDictionary::<CFString, *const c_void>::from_void(*windows.get(0)?) };

        unsafe {
            window_dict
                .find(kCGWindowOwnerName)
                .map(|v| CFString::from_void(*v).to_string())
        }
    }

    pub fn owner_pid(&self) -> Option<i32> {
        let windows =
            core_graphics::window::copy_window_info(kCGWindowListOptionIncludingWindow, self.0)?;

        let window_dict =
            unsafe { CFDictionary::<CFString, *const c_void>::from_void(*windows.get(0)?) };

        let key = CFString::from_static_string("kCGWindowOwnerPID");

        unsafe {
            window_dict
                .find(key.as_concrete_TypeRef())
                .and_then(|v| CFNumber::from_void(*v).to_i32())
        }
    }

    pub fn bundle_identifier(&self) -> Option<String> {
        let pid = self.owner_pid()?;

        unsafe {
            use cocoa::base::id;
            use cocoa::foundation::NSString;
            use objc::{class, msg_send, sel, sel_impl};

            let app: id = msg_send![
                class!(NSRunningApplication),
                runningApplicationWithProcessIdentifier: pid
            ];

            if app.is_null() {
                return None;
            }

            let bundle_identifier: id = msg_send![app, bundleIdentifier];
            if bundle_identifier.is_null() {
                return None;
            }

            let cstr = NSString::UTF8String(bundle_identifier);
            if cstr.is_null() {
                return None;
            }

            Some(
                std::ffi::CStr::from_ptr(cstr)
                    .to_string_lossy()
                    .into_owned(),
            )
        }
    }

    pub fn name(&self) -> Option<String> {
        let windows =
            core_graphics::window::copy_window_info(kCGWindowListOptionIncludingWindow, self.0)?;

        let window_dict =
            unsafe { CFDictionary::<CFString, *const c_void>::from_void(*windows.get(0)?) };

        unsafe {
            window_dict
                .find(kCGWindowName)
                .map(|v| CFString::from_void(*v).to_string())
        }
    }

    pub fn logical_bounds(&self) -> Option<LogicalBounds> {
        let windows =
            core_graphics::window::copy_window_info(kCGWindowListOptionIncludingWindow, self.0)?;

        let window_dict =
            unsafe { CFDictionary::<CFString, *const c_void>::from_void(*windows.get(0)?) };

        unsafe {
            window_dict
                .find(kCGWindowBounds)
                .and_then(|v| CGRect::from_dict_representation(&CFDictionary::from_void(*v)))
        }
        .map(|rect| LogicalBounds {
            position: LogicalPosition {
                x: rect.origin.x,
                y: rect.origin.y,
            },
            size: LogicalSize {
                width: rect.size.width,
                height: rect.size.height,
            },
        })
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        Some(self.logical_bounds()?.size())
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        let logical_bounds = self.logical_bounds()?;
        let display = self.display()?;

        let scale = display.physical_size()?.width() / display.logical_size()?.width();

        Some(PhysicalSize {
            width: logical_bounds.size().width() * scale,
            height: logical_bounds.size().height() * scale,
        })
    }

    pub fn app_icon(&self) -> Option<Vec<u8>> {
        use cocoa::base::{id, nil};
        use cocoa::foundation::{NSArray, NSAutoreleasePool, NSString};
        use objc::{class, msg_send, sel, sel_impl};

        let owner_name = self.owner_name()?;

        unsafe {
            let pool = NSAutoreleasePool::new(nil);

            let workspace_class = class!(NSWorkspace);
            let workspace: id = msg_send![workspace_class, sharedWorkspace];
            let running_apps: id = msg_send![workspace, runningApplications];
            let app_count = NSArray::count(running_apps);

            let result = (0..app_count).find_map(|i| {
                let app: id = running_apps.objectAtIndex(i);
                let localized_name: id = msg_send![app, localizedName];

                if localized_name.is_null() {
                    return None;
                }

                let name_str = NSString::UTF8String(localized_name);
                if name_str.is_null() {
                    return None;
                }

                let name = std::ffi::CStr::from_ptr(name_str)
                    .to_string_lossy()
                    .to_string();

                if name != owner_name {
                    return None;
                }

                let icon: id = msg_send![app, icon];
                if icon.is_null() {
                    return None;
                }

                let tiff_data: id = msg_send![icon, TIFFRepresentation];
                if tiff_data.is_null() {
                    return None;
                }

                let bitmap_rep_class = class!(NSBitmapImageRep);
                let bitmap_rep: id = msg_send![bitmap_rep_class, imageRepWithData: tiff_data];
                if bitmap_rep.is_null() {
                    return None;
                }

                let png_data: id = msg_send![
                    bitmap_rep,
                    representationUsingType: 4u64 // NSBitmapImageFileTypePNG
                    properties: nil
                ];
                if png_data.is_null() {
                    return None;
                }

                let length: usize = msg_send![png_data, length];
                let bytes_ptr: *const u8 = msg_send![png_data, bytes];

                if bytes_ptr.is_null() || length == 0 {
                    return None;
                }

                let bytes = std::slice::from_raw_parts(bytes_ptr, length);
                Some(bytes.to_vec())
            });

            pool.drain();
            result
        }
    }

    pub async fn as_sc(&self, content: arc::R<sc::ShareableContent>) -> Option<arc::R<sc::Window>> {
        content
            .windows()
            .iter()
            .find(|window| window.id() == self.0)
            .map(|window| window.retained())
    }

    pub fn display(&self) -> Option<DisplayImpl> {
        let descriptions = core_graphics::window::create_description_from_array(
            CFArray::from_copyable(&[self.0]),
        )?;

        let window_bounds = CGRect::from_dict_representation(
            &descriptions
                .get(0)?
                .get(unsafe { kCGWindowBounds })
                .downcast::<CFDictionary>()?,
        )?;

        for id in CGDisplay::active_displays().ok()? {
            let display = CGDisplay::new(id);
            if window_bounds.is_intersects(&display.bounds()) {
                return Some(DisplayImpl(display));
            }
        }

        None
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct DisplayIdImpl(CGDirectDisplayID);

impl std::fmt::Display for DisplayIdImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for DisplayIdImpl {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse()
            .map(Self)
            .map_err(|_| "Invalid display ID".to_string())
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct WindowIdImpl(CGWindowID);

impl std::fmt::Display for WindowIdImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for WindowIdImpl {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse()
            .map(Self)
            .map_err(|_| "Invalid window ID".to_string())
    }
}
