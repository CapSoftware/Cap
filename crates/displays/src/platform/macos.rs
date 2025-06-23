use std::{ptr::null_mut, str::FromStr};

use core_graphics::{
    display::{CGDirectDisplayID, CGDisplay, CGDisplayBounds},
    sys::CGEvent,
};
use serde::{Deserialize, Serialize};

use crate::bounds::{LogicalPosition, LogicalSize};

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

    pub fn get_display_at_cursor() -> Option<Self> {
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

        for display in Self::list() {
            let position = display.logical_position_raw();
            let size = display.logical_size();

            if location.x >= position.x
                && location.x < position.x + size.width
                && location.y >= position.y
                && location.y < position.y + size.height
            {
                return Some(display);
            }
        }

        None
    }
}

#[derive(Clone, PartialEq)]
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
