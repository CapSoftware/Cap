mod configuration;
pub mod cursor;
mod meta;

pub use configuration::*;
pub use cursor::*;
pub use meta::*;

use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingConfig {
    pub fps: u32,
    pub resolution: Resolution,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

impl Default for RecordingConfig {
    fn default() -> Self {
        Self {
            fps: 30,
            resolution: Resolution {
                width: 1920,
                height: 1080,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, Type, PartialEq)]
pub struct XY<T> {
    pub x: T,
    pub y: T,
}

impl<T> XY<T> {
    pub fn new(x: T, y: T) -> Self {
        Self { x, y }
    }

    pub fn map<U>(self, f: impl Fn(T) -> U) -> XY<U> {
        XY::new(f(self.x), f(self.y))
    }

    pub fn from_config(config_xy: configuration::XY<T>) -> Self {
        Self {
            x: config_xy.x,
            y: config_xy.y,
        }
    }

    pub fn to_config(self) -> configuration::XY<T> {
        configuration::XY {
            x: self.x,
            y: self.y,
        }
    }
}

impl<T: std::ops::Add<Output = T>> std::ops::Add for XY<T> {
    type Output = XY<T>;

    fn add(self, rhs: Self) -> Self::Output {
        XY::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl<T: std::ops::Sub<Output = T>> std::ops::Sub for XY<T> {
    type Output = XY<T>;

    fn sub(self, rhs: Self) -> Self::Output {
        XY::new(self.x - rhs.x, self.y - rhs.y)
    }
}

impl<T: std::ops::Mul<Output = T> + Copy> std::ops::Mul for XY<T> {
    type Output = XY<T>;

    fn mul(self, rhs: Self) -> Self::Output {
        XY::new(self.x * rhs.x, self.y * rhs.y)
    }
}

macro_rules! impl_scalar_ops {
    ($scalar:ty) => {
        impl std::ops::Mul<$scalar> for XY<$scalar> {
            type Output = XY<$scalar>;

            fn mul(self, rhs: $scalar) -> Self::Output {
                XY::new(self.x * rhs, self.y * rhs)
            }
        }

        impl std::ops::Div<$scalar> for XY<$scalar> {
            type Output = XY<$scalar>;

            fn div(self, rhs: $scalar) -> Self::Output {
                XY::new(self.x / rhs, self.y / rhs)
            }
        }

        impl std::ops::Sub<$scalar> for XY<$scalar> {
            type Output = XY<$scalar>;

            fn sub(self, rhs: $scalar) -> Self::Output {
                XY::new(self.x - rhs, self.y - rhs)
            }
        }
    };
}

impl_scalar_ops!(f32);
impl_scalar_ops!(f64);
impl_scalar_ops!(i32);
impl_scalar_ops!(u32);

impl<T: std::ops::Div<Output = T> + Copy> std::ops::Div for XY<T> {
    type Output = XY<T>;

    fn div(self, rhs: Self) -> Self::Output {
        XY::new(self.x / rhs.x, self.y / rhs.y)
    }
}

// Cross-type operations between root XY and configuration XY
impl<T: std::ops::Sub<Output = T>> std::ops::Sub<configuration::XY<T>> for XY<T> {
    type Output = XY<T>;

    fn sub(self, rhs: configuration::XY<T>) -> Self::Output {
        XY::new(self.x - rhs.x, self.y - rhs.y)
    }
}

impl<T: std::ops::Add<Output = T>> std::ops::Add<configuration::XY<T>> for XY<T> {
    type Output = XY<T>;

    fn add(self, rhs: configuration::XY<T>) -> Self::Output {
        XY::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl<T: std::ops::Mul<Output = T> + Copy> std::ops::Mul<configuration::XY<T>> for XY<T> {
    type Output = XY<T>;

    fn mul(self, rhs: configuration::XY<T>) -> Self::Output {
        XY::new(self.x * rhs.x, self.y * rhs.y)
    }
}

impl<T: std::ops::Div<Output = T> + Copy> std::ops::Div<configuration::XY<T>> for XY<T> {
    type Output = XY<T>;

    fn div(self, rhs: configuration::XY<T>) -> Self::Output {
        XY::new(self.x / rhs.x, self.y / rhs.y)
    }
}

#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, PartialOrd, Ord, Hash,
)]
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
    Wait,
    /// Windows: IDC_HELP
    Help,
    Hidden,
    Unknown,
}
