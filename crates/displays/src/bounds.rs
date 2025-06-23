#[derive(Clone, Copy, Debug)]
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

#[derive(Clone, Copy, Debug)]
pub struct PhysicalSize {
    pub(crate) width: f64,
    pub(crate) height: f64,
}

impl PhysicalSize {
    pub fn width(&self) -> f64 {
        self.width
    }

    pub fn height(&self) -> f64 {
        self.height
    }
}

#[derive(Clone, Copy, Debug)]
pub struct LogicalPosition {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

impl LogicalPosition {
    pub fn x(&self) -> f64 {
        self.x
    }

    pub fn y(&self) -> f64 {
        self.y
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PhysicalPosition {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

impl PhysicalPosition {
    pub fn x(&self) -> f64 {
        self.x
    }

    pub fn y(&self) -> f64 {
        self.y
    }
}
