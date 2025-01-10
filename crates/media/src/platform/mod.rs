use serde::{Deserialize, Serialize};
use specta::Type;

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod platform_impl;

#[cfg(target_os = "windows")]
#[path = "win.rs"]
mod platform_impl;

pub use platform_impl::*;

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, Type)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug)]
pub struct Window {
    pub window_id: u32,
    pub name: String,
    pub owner_name: String,
    pub process_id: u32,
    pub bounds: Bounds,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, PartialOrd, Ord)]
pub enum CursorShape {
    /// Windows: IDC_ARROW
    Arrow,
    /// Windows: IDC_IBEAM
    IBeam,
    /// Windows: IDC_CROSS
    Crosshair,
    /// macOS Only. Windows not supported.
    ClosedHand,
    /// macOS Only. Windows not supported.
    OpenHand,
    /// macOS Only. Windows not supported.
    PointingHand,
    /// macOS Only. Windows not supported.
    ResizeLeft,
    /// macOS Only. Windows not supported.
    ResizeRight,
    /// Windows: IDC_SIZEWE
    ResizeLeftRight,
    /// Windows: IDC_UPARROW
    ResizeUp,
    /// macOS Only. Windows not supported.
    ResizeDown,
    /// Windows: IDC_SIZENS
    ResizeUpDown,
    /// Windows: IDC_SIZENWSE
    ///
    /// Windows only. macOS not supported.
    ResizeUpLeftAndDownRight,
    /// Windows: IDC_SIZENESW
    ///
    /// Windows only. macOS not supported.
    ResizeUpRightAndDownLeft,
    /// Windows: IDC_SIZEALL
    ///
    /// Windows only. macOS not supported.
    ResizeAll,
    /// macOS Only. Windows not supported.
    DisappearingItem,
    /// macOS Only. Windows not supported.
    VerticalIBeam,
    /// Windows: IDC_NO
    NotAllowed,
    /// macOS Only. Windows not supported.
    DragLink,
    /// macOS Only. Windows not supported.
    DragCopy,
    /// macOS Only. Windows not supported.
    ContextualMenu,
    /// Windows only. macOS not supported.
    Appstarting,
    /// Windows: IDC_WAIT
    ///
    /// Windows only. macOS not supported.
    Wait,
    /// Windows: IDC_HELP
    ///
    /// Windows only. macOS not supported.
    Help,
    /// Windows only. macOS not supported.
    ///
    /// Indicates the cursor is not visible.
    Hidden,
    /// Couldn't get the cursor shape.
    Unknown,
}
