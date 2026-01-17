use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Copy, Debug, Type, Serialize, Deserialize)]
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

    pub fn intersects(&self, other: &LogicalBounds) -> bool {
        let self_right = self.position.x() + self.size.width();
        let self_bottom = self.position.y() + self.size.height();
        let other_right = other.position.x() + other.size.width();
        let other_bottom = other.position.y() + other.size.height();

        self.position.x() < other_right
            && self_right > other.position.x()
            && self.position.y() < other_bottom
            && self_bottom > other.position.y()
    }

    pub fn intersect(&self, other: &LogicalBounds) -> Option<LogicalBounds> {
        if !self.intersects(other) {
            return None;
        }

        let x = self.position.x().max(other.position.x());
        let y = self.position.y().max(other.position.y());
        let right = (self.position.x() + self.size.width())
            .min(other.position.x() + other.size.width());
        let bottom = (self.position.y() + self.size.height())
            .min(other.position.y() + other.size.height());

        Some(LogicalBounds::new(
            LogicalPosition::new(x, y),
            LogicalSize::new(right - x, bottom - y),
        ))
    }

    pub fn contains_bounds(&self, other: &LogicalBounds) -> bool {
        let other_right = other.position.x() + other.size.width();
        let other_bottom = other.position.y() + other.size.height();
        let self_right = self.position.x() + self.size.width();
        let self_bottom = self.position.y() + self.size.height();

        other.position.x() >= self.position.x()
            && other.position.y() >= self.position.y()
            && other_right <= self_right
            && other_bottom <= self_bottom
    }
}

#[derive(Clone, Copy, Debug, Type, Serialize, Deserialize)]
pub struct PhysicalBounds {
    pub(crate) position: PhysicalPosition,
    pub(crate) size: PhysicalSize,
}

impl PhysicalBounds {
    pub fn new(position: PhysicalPosition, size: PhysicalSize) -> Self {
        Self { position, size }
    }

    pub fn position(&self) -> PhysicalPosition {
        self.position
    }

    pub fn size(&self) -> PhysicalSize {
        self.size
    }

    pub fn contains_point(&self, point: PhysicalPosition) -> bool {
        point.x() >= self.position.x()
            && point.x() < self.position.x() + self.size.width()
            && point.y() >= self.position.y()
            && point.y() < self.position.y() + self.size.height()
    }
}

#[derive(Clone, Copy, Debug, Type, Serialize, Deserialize, PartialEq)]
pub struct LogicalSize {
    pub(crate) width: f64,
    pub(crate) height: f64,
}

impl LogicalSize {
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

#[derive(Clone, Copy, Debug, Type, Serialize, Deserialize, PartialEq)]
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

    pub fn map(&self, f: impl Fn(f64) -> f64) -> Self {
        Self {
            width: f(self.width),
            height: f(self.height),
        }
    }
}

#[derive(Clone, Copy, Debug, Type, Serialize, Deserialize, PartialEq)]
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

#[derive(Clone, Copy, Debug, Type, Serialize, Deserialize)]
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
