use std::ops::Sub;

use serde::Serialize;
use specta::Type;

#[derive(Clone, Copy, Debug, Type, Serialize)]
pub struct LogicalBounds {
    pub(crate) position: LogicalPosition,
    pub(crate) size: LogicalSize,
}

impl LogicalBounds {
    pub fn new(position: LogicalPosition, size: LogicalSize) -> Self {
        Self { position, size }
    }

    pub fn position(&self) -> LogicalPosition {
        self.position
    }

    pub fn size(&self) -> LogicalSize {
        self.size
    }

    pub fn contains_point(&self, point: LogicalPosition) -> bool {
        point.x() >= self.position.x()
            && point.x() < self.position.x() + self.size.width()
            && point.y() >= self.position.y()
            && point.y() < self.position.y() + self.size.height()
    }
}

#[derive(Clone, Copy, Debug, Type, Serialize)]
pub struct LogicalSize {
    pub(crate) width: f64,
    pub(crate) height: f64,
}

impl LogicalSize {
    pub fn width(&self) -> f64 {
        self.width
    }

    pub fn height(&self) -> f64 {
        self.height
    }
}

#[derive(Clone, Copy, Debug, Type, Serialize)]
pub struct PhysicalSize {
    pub(crate) width: f64,
    pub(crate) height: f64,
}

impl PhysicalSize {
    pub fn new(width: f64, height: f64) -> Self {
        Self { width, height }
    }

    pub fn width(&self) -> f64 {
        self.width
    }

    pub fn height(&self) -> f64 {
        self.height
    }
}

#[derive(Clone, Copy, Debug, Type, Serialize)]
pub struct LogicalPosition {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

impl LogicalPosition {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn x(&self) -> f64 {
        self.x
    }

    pub fn y(&self) -> f64 {
        self.y
    }
}

impl Sub<LogicalPosition> for LogicalPosition {
    type Output = LogicalPosition;

    fn sub(self, other: LogicalPosition) -> LogicalPosition {
        LogicalPosition::new(self.x() - other.x(), self.y() - other.y())
    }
}

#[derive(Clone, Copy, Debug, Type, Serialize)]
pub struct PhysicalPosition {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

impl PhysicalPosition {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn x(&self) -> f64 {
        self.x
    }

    pub fn y(&self) -> f64 {
        self.y
    }
}
