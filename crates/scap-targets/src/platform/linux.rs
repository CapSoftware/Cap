use std::str::FromStr;

use crate::bounds::{LogicalSize, PhysicalSize};

#[derive(Clone, Copy)]
pub struct DisplayImpl(u64);

impl DisplayImpl {
    pub fn primary() -> Self {
        Self(0)
    }

    pub fn list() -> Vec<Self> {
        vec![Self::primary()]
    }

    pub fn raw_id(&self) -> DisplayIdImpl {
        DisplayIdImpl(self.0)
    }

    pub fn get_containing_cursor() -> Option<Self> {
        Some(Self::primary())
    }

    pub fn name(&self) -> Option<String> {
        Some("Display".to_string())
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        Some(PhysicalSize::new(1920.0, 1080.0))
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        self.physical_size()
            .map(|size| LogicalSize::new(size.width(), size.height()))
    }

    pub fn refresh_rate(&self) -> f64 {
        60.0
    }
}

#[derive(Clone, Copy)]
pub struct WindowImpl(u64);

impl WindowImpl {
    pub fn list() -> Vec<Self> {
        Vec::new()
    }

    pub fn list_containing_cursor() -> Vec<Self> {
        Vec::new()
    }

    pub fn get_topmost_at_cursor() -> Option<Self> {
        None
    }

    pub fn id(&self) -> WindowIdImpl {
        WindowIdImpl(self.0)
    }

    pub fn level(&self) -> Option<i32> {
        Some(0)
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        None
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        None
    }

    pub fn owner_name(&self) -> Option<String> {
        None
    }

    pub fn app_icon(&self) -> Option<Vec<u8>> {
        None
    }

    pub fn display(&self) -> Option<DisplayImpl> {
        Some(DisplayImpl::primary())
    }

    pub fn name(&self) -> Option<String> {
        None
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct DisplayIdImpl(u64);

impl std::fmt::Display for DisplayIdImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for DisplayIdImpl {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<u64>()
            .map(Self)
            .map_err(|_| "Invalid display ID".to_string())
    }
}

#[derive(Clone, PartialEq, Debug)]
pub struct WindowIdImpl(u64);

impl std::fmt::Display for WindowIdImpl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for WindowIdImpl {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<u64>()
            .map(Self)
            .map_err(|_| "Invalid window ID".to_string())
    }
}
