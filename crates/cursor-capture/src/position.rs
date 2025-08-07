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

// relative to display using top-left origin
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
            let raw_display = display.raw_handle().inner();
            let display_bounds = raw_display.bounds();

            Self {
                x: raw.x - display_bounds.origin.x as i32,
                y: raw.y - display_bounds.origin.y as i32,
                display,
            }
        }

        #[cfg(windows)]
        {
            let _ = (raw, display);
            todo!()
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
        #[allow(unused_variables)]
        let (x, y) = {
            todo!();
            // let display_bounds = self.display().raw_handle().bounds();

            // (
            //     self.x as f32 / (display_bounds.right - display_bounds.left) as f32,
            //     self.y as f32 / (display_bounds.bottom - display_bounds.top) as f32,
            // )
        };

        #[allow(unreachable_code)]
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
        let raw_px = (
            self.x * self.crop_size.0 + self.crop_position.0,
            self.y * self.crop_size.1 + self.crop_position.1,
        );

        Self {
            x: (raw_px.0 - position.0) / size.0,
            y: (raw_px.1 - position.1) / size.1,
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

#[cfg(test)]
mod tests {
    use super::*;
    use cap_displays::Display;

    // Helper function to create a mock Display for testing
    fn mock_display() -> Display {
        Display::list()[0]
    }

    #[test]
    fn test_with_crop_no_change() {
        let display = mock_display();
        let original_normalized = NormalizedCursorPosition {
            x: 0.5,
            y: 0.5,
            crop_position: (0.0, 0.0),
            crop_size: (1.0, 1.0),
            display,
        };

        let cropped_position = (0.0, 0.0);
        let cropped_size = (1.0, 1.0);
        let new_normalized = original_normalized.with_crop(cropped_position, cropped_size);

        assert_eq!(new_normalized.x, 0.5);
        assert_eq!(new_normalized.y, 0.5);
        assert_eq!(new_normalized.crop_position(), (0.0, 0.0));
        assert_eq!(new_normalized.crop_size(), (1.0, 1.0));
    }

    #[test]
    fn test_with_crop_centered() {
        let display = mock_display();
        let original_normalized = NormalizedCursorPosition {
            x: 0.5,
            y: 0.5,
            crop_position: (0.0, 0.0),
            crop_size: (1.0, 1.0),
            display,
        };

        let cropped_position = (0.25, 0.25);
        let cropped_size = (0.5, 0.5);
        let new_normalized = original_normalized.with_crop(cropped_position, cropped_size);

        // Original point (0.5, 0.5) is in the center of the (0,0) to (1,1) range.
        // The new crop is from (0.25, 0.25) to (0.75, 0.75).
        // The original point (0.5, 0.5) should still be in the center of this new crop.
        let expected_x = (0.5 * 1.0 + 0.0 - 0.25) / 0.5;
        let expected_y = (0.5 * 1.0 + 0.0 - 0.25) / 0.5;

        assert!((new_normalized.x - expected_x).abs() < f32::EPSILON);
        assert!((new_normalized.y - expected_y).abs() < f32::EPSILON);
        assert_eq!(new_normalized.crop_position(), (0.25, 0.25));
        assert_eq!(new_normalized.crop_size(), (0.5, 0.5));
    }

    #[test]
    fn test_with_crop_top_left_of_crop() {
        let display = mock_display();

        let cropped_position = (0.25, 0.25);
        let cropped_size = (0.5, 0.5);

        let original_normalized_at_crop_tl = NormalizedCursorPosition {
            x: 0.25,
            y: 0.25,
            crop_position: (0.0, 0.0),
            crop_size: (1.0, 1.0),
            display,
        };

        let new_normalized =
            original_normalized_at_crop_tl.with_crop(cropped_position, cropped_size);

        // The point that was at the top-left of the crop in the original space
        // should now be at (0.0, 0.0) in the new cropped space.
        assert!((new_normalized.x - 0.0).abs() < f32::EPSILON);
        assert!((new_normalized.y - 0.0).abs() < f32::EPSILON);
        assert_eq!(new_normalized.crop_position(), (0.25, 0.25));
        assert_eq!(new_normalized.crop_size(), (0.5, 0.5));
    }

    #[test]
    fn test_with_crop_bottom_right_of_crop() {
        let display = mock_display();

        let cropped_position = (0.25, 0.25);
        let cropped_size = (0.5, 0.5);

        let original_normalized_at_crop_br = NormalizedCursorPosition {
            x: 0.75,
            y: 0.75,
            crop_position: (0.0, 0.0),
            crop_size: (1.0, 1.0),
            display,
        };

        let new_normalized =
            original_normalized_at_crop_br.with_crop(cropped_position, cropped_size);

        // The point that was at the bottom-right of the crop in the original space
        // should now be at (1.0, 1.0) in the new cropped space.
        assert!((new_normalized.x - 1.0).abs() < f32::EPSILON);
        assert!((new_normalized.y - 1.0).abs() < f32::EPSILON);
        assert_eq!(new_normalized.crop_position(), (0.25, 0.25));
        assert_eq!(new_normalized.crop_size(), (0.5, 0.5));
    }

    #[test]
    fn test_with_crop_from_existing_crop() {
        let display = mock_display();
        let original_normalized = NormalizedCursorPosition {
            x: 0.5, // This 0.5 is within the first crop
            y: 0.5, // This 0.5 is within the first crop
            crop_position: (0.1, 0.1),
            crop_size: (0.8, 0.8),
            display,
        };

        // The raw position of the cursor is 0.5 within the 0.1 to 0.9 range.
        // Raw x = 0.5 * 0.8 + 0.1 = 0.4 + 0.1 = 0.5
        // Raw y = 0.5 * 0.8 + 0.1 = 0.4 + 0.1 = 0.5

        let second_crop_position = (0.2, 0.2);
        let second_crop_size = (0.6, 0.6);

        // The second crop is from 0.2 to 0.8 in the original space.
        // The raw position is (0.5, 0.5).
        // In the second crop space, this should be:
        // x = (0.5 - 0.2) / 0.6 = 0.3 / 0.6 = 0.5
        // y = (0.5 - 0.2) / 0.6 = 0.3 / 0.6 = 0.5

        let new_normalized = original_normalized.with_crop(second_crop_position, second_crop_size);

        assert!((new_normalized.x - 0.5).abs() < f32::EPSILON);
        assert!((new_normalized.y - 0.5).abs() < f32::EPSILON);
        assert_eq!(new_normalized.crop_position(), (0.2, 0.2));
        assert_eq!(new_normalized.crop_size(), (0.6, 0.6));
    }
}
