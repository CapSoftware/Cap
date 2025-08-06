use std::{ffi::c_void, str::FromStr};

use core_foundation::{base::FromVoid, number::CFNumber, string::CFString};
use core_graphics::{
    display::{
        CFDictionary, CGDirectDisplayID, CGDisplay, CGDisplayBounds, CGRect,
        kCGWindowListOptionIncludingWindow,
    },
    window::{CGWindowID, kCGWindowBounds, kCGWindowLayer, kCGWindowNumber, kCGWindowOwnerName},
};

use crate::bounds::{LogicalBounds, LogicalPosition, LogicalSize};

// Some notes about macOS:
// Coordinate system origin is top left of primary. Down and right are positive.

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

    pub fn id(&self) -> String {
        self.0.id.to_string()
    }

    pub fn from_id(id: String) -> Option<Self> {
        Self::list().into_iter().find(|d| d.id() == id)
    }

    pub fn logical_size(&self) -> LogicalSize {
        let rect = unsafe { CGDisplayBounds(self.0.id) };

        LogicalSize {
            width: rect.size.width,
            height: rect.size.height,
        }
    }

    // Logical position relative to the CoreGraphics coordinate system
    // - Origin: Top Left
    // - Move Right: Positive
    // - Move Down: Positive
    pub fn logical_position_raw(&self) -> LogicalPosition {
        let rect = unsafe { CGDisplayBounds(self.0.id) };

        LogicalPosition {
            x: rect.origin.x,
            y: rect.origin.y,
        }
    }

    pub fn get_containing_cursor() -> Option<Self> {
        let cursor = get_cursor_position()?;

        for display in Self::list() {
            let position = display.logical_position_raw();
            let size = display.logical_size();

            if cursor.x() >= position.x()
                && cursor.x() < position.x() + size.width()
                && cursor.y() >= position.y()
                && cursor.y() < position.y() + size.height()
            {
                return Some(display);
            }
        }

        None
    }
}

fn get_cursor_position() -> Option<LogicalPosition> {
    let location = {
        let event = core_graphics::event::CGEvent::new(
            core_graphics::event_source::CGEventSource::new(
                core_graphics::event_source::CGEventSourceStateID::Private,
            )
            .ok()?,
        )
        .ok()?;
        event.location()
    };

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
                let bounds = window.bounds()?;

                let contains_cursor = cursor.x() > bounds.position().x()
                    && cursor.x() < bounds.position().x() + bounds.size().width()
                    && cursor.y() > bounds.position().y()
                    && cursor.y() < bounds.position().y() + bounds.size().height();

                contains_cursor.then_some(window)
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

        if windows_with_level.len() > 0 {
            Some(windows_with_level.swap_remove(0).0)
        } else {
            None
        }
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

    pub fn bounds(&self) -> Option<LogicalBounds> {
        let windows =
            core_graphics::window::copy_window_info(kCGWindowListOptionIncludingWindow, self.0)?;

        let window_dict =
            unsafe { CFDictionary::<CFString, *const c_void>::from_void(*windows.get(0)?) };

        unsafe {
            window_dict
                .find(kCGWindowBounds)
                .and_then(|v| CGRect::from_dict_representation(&*CFDictionary::from_void(*v)))
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
