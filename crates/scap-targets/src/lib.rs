pub mod bounds;
pub mod platform;

use bounds::*;
pub use platform::{DisplayIdImpl, DisplayImpl, WindowIdImpl, WindowImpl};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::str::FromStr;

use crate::bounds::{LogicalPosition, LogicalSize};

#[derive(Clone, Copy)]
pub struct Display(DisplayImpl);

impl Display {
    pub fn list() -> Vec<Self> {
        DisplayImpl::list().into_iter().map(Self).collect()
    }

    pub fn primary() -> Self {
        Self(DisplayImpl::primary())
    }

    pub fn raw_handle(&self) -> &DisplayImpl {
        &self.0
    }

    pub fn id(&self) -> DisplayId {
        DisplayId(self.0.raw_id())
    }

    pub fn from_id(id: &DisplayId) -> Option<Self> {
        Self::list().into_iter().find(|d| &d.id() == id)
    }

    pub fn get_containing_cursor() -> Option<Self> {
        DisplayImpl::get_containing_cursor().map(Self)
    }

    pub fn name(&self) -> Option<String> {
        self.0.name()
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        self.0.physical_size()
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        self.0.logical_size()
    }

    pub fn refresh_rate(&self) -> f64 {
        self.0.refresh_rate()
    }
}

#[derive(Serialize, Deserialize, Type, Clone, PartialEq, Debug)]
pub struct DisplayId(
    #[serde(with = "serde_display_id")]
    #[specta(type = String)]
    DisplayIdImpl,
);

impl std::fmt::Display for DisplayId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for DisplayId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<DisplayIdImpl>().map(Self)
    }
}

mod serde_display_id {
    use serde::{Deserialize, Deserializer, Serializer};

    use crate::platform::DisplayIdImpl;

    pub fn serialize<S>(this: &DisplayIdImpl, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&this.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<DisplayIdImpl, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        s.parse::<DisplayIdImpl>().map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy)]
pub struct Window(WindowImpl);

impl Window {
    pub fn list() -> Vec<Self> {
        WindowImpl::list().into_iter().map(Self).collect()
    }

    pub fn list_containing_cursor() -> Vec<Self> {
        WindowImpl::list_containing_cursor()
            .into_iter()
            .map(Self)
            .collect()
    }

    pub fn get_topmost_at_cursor() -> Option<Self> {
        WindowImpl::get_topmost_at_cursor().map(Self)
    }

    pub fn id(&self) -> WindowId {
        WindowId(self.0.id())
    }

    pub fn from_id(id: &WindowId) -> Option<Self> {
        Self::list().into_iter().find(|d| &d.id() == id)
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        self.0.physical_size()
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        self.0.logical_size()
    }

    pub fn owner_name(&self) -> Option<String> {
        self.0.owner_name()
    }

    pub fn app_icon(&self) -> Option<Vec<u8>> {
        self.0.app_icon()
    }

    pub fn raw_handle(&self) -> &WindowImpl {
        &self.0
    }

    pub fn display(&self) -> Option<Display> {
        self.0.display().map(Display)
    }

    pub fn name(&self) -> Option<String> {
        self.0.name()
    }

    pub fn display_relative_logical_bounds(&self) -> Option<LogicalBounds> {
        let display = self.display()?;

        #[cfg(target_os = "macos")]
        {
            let display_logical_bounds = display.raw_handle().logical_bounds()?;
            let window_logical_bounds = self.raw_handle().logical_bounds()?;

            Some(LogicalBounds::new(
                LogicalPosition::new(
                    window_logical_bounds.position().x() - display_logical_bounds.position().x(),
                    window_logical_bounds.position().y() - display_logical_bounds.position().y(),
                ),
                window_logical_bounds.size(),
            ))
        }

        #[cfg(target_os = "linux")]
        {
            let display_logical_bounds = display.raw_handle().logical_bounds()?;
            let window_logical_bounds = self.raw_handle().logical_bounds()?;

            Some(LogicalBounds::new(
                LogicalPosition::new(
                    window_logical_bounds.position().x() - display_logical_bounds.position().x(),
                    window_logical_bounds.position().y() - display_logical_bounds.position().y(),
                ),
                window_logical_bounds.size(),
            ))
        }

        #[cfg(windows)]
        {
            let display_physical_bounds = display.raw_handle().physical_bounds()?;
            let display_logical_size = display.logical_size()?;
            let window_physical_bounds: PhysicalBounds = self.raw_handle().physical_bounds()?;

            let scale = display_logical_size.width() / display_physical_bounds.size().width;

            let display_relative_physical_bounds = PhysicalBounds::new(
                PhysicalPosition::new(
                    window_physical_bounds.position().x - display_physical_bounds.position().x,
                    window_physical_bounds.position().y - display_physical_bounds.position().y,
                ),
                window_physical_bounds.size(),
            );

            Some(LogicalBounds::new(
                LogicalPosition::new(
                    display_relative_physical_bounds.position().x() * scale,
                    display_relative_physical_bounds.position().y() * scale,
                ),
                LogicalSize::new(
                    display_relative_physical_bounds.size().width() * scale,
                    display_relative_physical_bounds.size().height() * scale,
                ),
            ))
        }
    }
}

#[derive(Serialize, Deserialize, Type, Clone, PartialEq, Debug)]
pub struct WindowId(
    #[serde(with = "serde_window_id")]
    #[specta(type = String)]
    WindowIdImpl,
);

impl std::fmt::Display for WindowId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for WindowId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<WindowIdImpl>().map(Self)
    }
}

mod serde_window_id {
    use serde::{Deserialize, Deserializer, Serializer};

    use crate::WindowIdImpl;

    pub fn serialize<S>(this: &WindowIdImpl, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&this.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<WindowIdImpl, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        s.parse::<WindowIdImpl>().map_err(serde::de::Error::custom)
    }
}
