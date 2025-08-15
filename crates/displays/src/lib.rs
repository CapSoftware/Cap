pub mod bounds;
pub mod platform;

use std::str::FromStr;

use bounds::{LogicalBounds, PhysicalSize};
pub use platform::{DisplayIdImpl, DisplayImpl, WindowIdImpl, WindowImpl};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::bounds::PhysicalBounds;

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

    pub fn name(&self) -> String {
        self.0.name()
    }

    pub fn physical_size(&self) -> PhysicalSize {
        self.0.physical_size()
    }

    pub fn refresh_rate(&self) -> f64 {
        self.0.refresh_rate()
    }

    pub fn logical_bounds(&self) -> LogicalBounds {
        self.0.logical_bounds()
    }

    // pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
    //     self.0.physical_bounds()
    // }
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

    pub fn logical_bounds(&self) -> Option<LogicalBounds> {
        self.0.logical_bounds()
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        self.0.physical_size()
    }

    // pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
    //     self.0.physical_bounds()
    // }

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
