use cap_displays::Display;
use device_query::{DeviceQuery, DeviceState};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawCursorPosition {
    pub(crate) x: i32,
    pub(crate) y: i32,
}

impl RawCursorPosition {
    pub fn get() -> Self {
        let device_state = DeviceState::new();
        let position = device_state.get_mouse().coords;

        Self {
            x: position.0,
            y: position.1,
        }
    }

    pub fn relative_to_display(&self, display: Display) -> RelativeCursorPosition {
        RelativeCursorPosition::from_raw(*self, display)
    }
}

#[derive(Clone, Copy)]
pub struct RelativeCursorPosition {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) display: Display,
}

impl RelativeCursorPosition {
    pub fn from_raw(raw: RawCursorPosition, display: Display) -> Self {
        #[cfg(target_os = "macos")]
        {
            let primary_display = cap_displays::DisplayImpl::primary();

            let raw_display = display.raw_handle().inner();
            let display_bounds = raw_display.bounds();

            return Self {
                x: raw.x - display_bounds.origin.x as i32,
                y: (primary_display.inner().pixels_high() - 1) as i32
                    - (raw.y - display_bounds.origin.y as i32),
                display,
            };
        }

        #[cfg(windows)]
        {
            let raw_display = display.raw_handle().inner();
            let display_bounds = raw_display.bounds();

            Self {
                x: raw.x - display_bounds.origin.x as i32,
                y: raw.y - display_bounds.origin.y as i32,
                display,
            }
        }
    }

    pub fn x(&self) -> i32 {
        self.x
    }

    pub fn y(&self) -> i32 {
        self.y
    }

    pub fn display(&self) -> &Display {
        &self.display
    }

    pub fn normalize(&self) -> NormalizedCursorPosition {
        #[cfg(target_os = "macos")]
        let (x, y) = {
            let display_bounds = self.display().raw_handle().inner().bounds();

            (
                self.x as f32 / display_bounds.size.width as f32,
                self.y as f32 / display_bounds.size.height as f32,
            )
        };

        #[cfg(windows)]
        let (x, y) = {
            let display_bounds = self.display().raw_handle().bounds();

            (
                self.x as f32 / (display_bounds.right - display_bounds.left) as f32,
                self.y as f32 / (display_bounds.bottom - display_bounds.top) as f32,
            )
        };

        NormalizedCursorPosition {
            x,
            y,
            crop_position: (0.0, 0.0),
            crop_size: (1.0, 1.0),
            display: self.display,
        }
    }
}

impl std::fmt::Debug for RelativeCursorPosition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelativeCursorPosition")
            .field("x", &self.x)
            .field("y", &self.y)
            .finish()
    }
}

pub struct NormalizedCursorPosition {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) crop_position: (f32, f32),
    pub(crate) crop_size: (f32, f32),
    pub(crate) display: Display,
}

impl NormalizedCursorPosition {
    pub fn x(&self) -> f32 {
        self.x
    }

    pub fn y(&self) -> f32 {
        self.y
    }

    pub fn display(&self) -> &Display {
        &self.display
    }

    pub fn crop_position(&self) -> (f32, f32) {
        self.crop_position
    }

    pub fn crop_size(&self) -> (f32, f32) {
        self.crop_size
    }

    pub fn with_crop(&self, position: (f32, f32), size: (f32, f32)) -> Self {
        let raw_normalized = (
            self.x / self.crop_size.0 - self.crop_position.0,
            self.y / self.crop_size.1 - self.crop_position.1,
        );

        Self {
            x: raw_normalized.0 / size.0 - position.0,
            y: raw_normalized.1 / size.1 - position.1,
            crop_position: position,
            crop_size: size,
            display: self.display,
        }
    }
}

impl std::fmt::Debug for NormalizedCursorPosition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NormalizedCursorPosition")
            .field("x", &self.x)
            .field("y", &self.y)
            .finish()
    }
}
