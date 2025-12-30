use crate::bounds::{LogicalBounds, LogicalSize, PhysicalBounds, PhysicalSize};

pub type DisplayIdImpl = u64;
pub type WindowIdImpl = u64;

#[derive(Clone, Copy)]
pub struct DisplayImpl;

impl DisplayImpl {
    pub fn list() -> Vec<Self> {
        Vec::new()
    }

    pub fn primary() -> Self {
        Self
    }

    pub fn get_containing_cursor() -> Option<Self> {
        None
    }

    pub fn raw_id(&self) -> DisplayIdImpl {
        0
    }

    pub fn name(&self) -> Option<String> {
        None
    }

    pub fn physical_size(&self) -> Option<PhysicalSize> {
        None
    }

    pub fn logical_size(&self) -> Option<LogicalSize> {
        None
    }

    pub fn refresh_rate(&self) -> f64 {
        0.0
    }

    pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
        None
    }

    pub fn logical_bounds(&self) -> Option<LogicalBounds> {
        None
    }
}

#[derive(Clone, Copy)]
pub struct WindowImpl;

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
        0
    }

    pub fn level(&self) -> Option<i32> {
        None
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

    pub fn name(&self) -> Option<String> {
        None
    }

    pub fn display(&self) -> Option<DisplayImpl> {
        None
    }

    pub fn physical_bounds(&self) -> Option<PhysicalBounds> {
        None
    }

    pub fn logical_bounds(&self) -> Option<LogicalBounds> {
        None
    }
}
