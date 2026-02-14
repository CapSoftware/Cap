use device_query::{DeviceQuery, DeviceState};
use scap_targets::Display;
#[cfg(any(windows, target_os = "macos"))]
use scap_targets::bounds::*;

// Physical on Windows, Logical on macOS
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawCursorPosition {
    x: i32,
    y: i32,
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

    pub fn relative_to_display(&self, display: Display) -> Option<RelativeCursorPosition> {
        RelativeCursorPosition::from_raw(*self, display)
    }
}

// relative to display using top-left origin
#[derive(Clone, Copy)]
pub struct RelativeCursorPosition {
    x: i32,
    y: i32,
    display: Display,
}

impl RelativeCursorPosition {
    pub fn from_raw(raw: RawCursorPosition, display: Display) -> Option<Self> {
        #[cfg(windows)]
        {
            let physical_bounds = display.raw_handle().physical_bounds()?;

            Some(Self {
                x: raw.x - physical_bounds.position().x() as i32,
                y: raw.y - physical_bounds.position().y() as i32,
                display,
            })
        }

        #[cfg(target_os = "macos")]
        {
            let logical_bounds = display.raw_handle().logical_bounds()?;

            Some(Self {
                x: raw.x - logical_bounds.position().x() as i32,
                y: raw.y - logical_bounds.position().y() as i32,
                display,
            })
        }

        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (raw, display);
            None
        }
    }

    pub fn display(&self) -> &Display {
        &self.display
    }

    pub fn normalize(&self) -> Option<NormalizedCursorPosition> {
        #[cfg(windows)]
        {
            let bounds = self.display().raw_handle().physical_bounds()?;
            let size = bounds.size();

            Some(NormalizedCursorPosition {
                x: self.x as f64 / size.width(),
                y: self.y as f64 / size.height(),
                crop: CursorCropBounds {
                    x: 0.0,
                    y: 0.0,
                    width: size.width(),
                    height: size.height(),
                },
                display: self.display,
            })
        }

        #[cfg(target_os = "macos")]
        {
            let bounds = self.display().raw_handle().logical_bounds()?;
            let size = bounds.size();

            Some(NormalizedCursorPosition {
                x: self.x as f64 / size.width(),
                y: self.y as f64 / size.height(),
                crop: CursorCropBounds {
                    x: 0.0,
                    y: 0.0,
                    width: size.width(),
                    height: size.height(),
                },
                display: self.display,
            })
        }

        #[cfg(not(any(windows, target_os = "macos")))]
        {
            None
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

#[derive(Clone, Copy, Debug)]
/// Needs to be logical coordinates on macOS and physical on Windows
/// This type is opqaue on purpose as the logical/physical invariants need to hold
pub struct CursorCropBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl CursorCropBounds {
    #[cfg(target_os = "macos")]
    pub fn new_macos(bounds: LogicalBounds) -> Self {
        Self {
            x: bounds.position().x(),
            y: bounds.position().y(),
            width: bounds.size().width(),
            height: bounds.size().height(),
        }
    }

    #[cfg(target_os = "windows")]
    pub fn new_windows(bounds: PhysicalBounds) -> Self {
        Self {
            x: bounds.position().x(),
            y: bounds.position().y(),
            width: bounds.size().width(),
            height: bounds.size().height(),
        }
    }

    pub fn x(&self) -> f64 {
        self.x
    }

    pub fn y(&self) -> f64 {
        self.y
    }

    pub fn width(&self) -> f64 {
        self.width
    }

    pub fn height(&self) -> f64 {
        self.height
    }
}

pub struct NormalizedCursorPosition {
    x: f64,
    y: f64,
    crop: CursorCropBounds,
    display: Display,
}

impl NormalizedCursorPosition {
    pub fn x(&self) -> f64 {
        self.x
    }

    pub fn y(&self) -> f64 {
        self.y
    }

    pub fn display(&self) -> &Display {
        &self.display
    }

    pub fn crop(&self) -> CursorCropBounds {
        self.crop
    }

    pub fn with_crop(&self, crop: CursorCropBounds) -> Self {
        let raw_px = (
            self.x * self.crop.width + self.crop.x,
            self.y * self.crop.height + self.crop.y,
        );

        Self {
            x: (raw_px.0 - crop.x) / crop.width,
            y: (raw_px.1 - crop.y) / crop.height,
            crop,
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

// #[cfg(test)]
// mod tests {
//     use super::*;
//     use scap_targets::Display;

//     // Helper function to create a mock Display for testing
//     fn mock_display() -> Display {
//         Display::list()[0]
//     }

//     #[test]
//     fn test_with_crop_no_change() {
//         let display = mock_display();
//         let original_normalized = NormalizedCursorPosition {
//             x: 0.5,
//             y: 0.5,
//             crop: CursorCropBounds {
//                 x: 0.0,
//                 y: 0.0,
//                 width: 1.0,
//                 height: 1.0,
//             },
//             display,
//         };

//         let crop = CursorCropBounds {
//             x: 0.0,
//             y: 0.0,
//             width: 1.0,
//             height: 1.0,
//         };
//         let new_normalized = original_normalized.with_crop(crop);

//         assert_eq!(new_normalized.x, 0.5);
//         assert_eq!(new_normalized.y, 0.5);
//         assert_eq!(
//             new_normalized.crop_position(),
//             LogicalPosition::new(0.0, 0.0)
//         );
//         assert_eq!(new_normalized.crop_size(), LogicalSize::new(1.0, 1.0));
//     }

//     #[test]
//     fn test_with_crop_centered() {
//         let display = mock_display();
//         let original_normalized = NormalizedCursorPosition {
//             x: 0.5,
//             y: 0.5,
//             crop_position: LogicalPosition::new(0.0, 0.0),
//             crop_size: LogicalSize::new(1.0, 1.0),
//             display,
//         };

//         let cropped_position = LogicalPosition::new(0.25, 0.25);
//         let cropped_size = LogicalSize::new(0.5, 0.5);
//         let new_normalized = original_normalized.with_crop(cropped_position, cropped_size);

//         // Original point (0.5, 0.5) is in the center of the (0,0) to (1,1) range.
//         // The new crop is from (0.25, 0.25) to (0.75, 0.75).
//         // The original point (0.5, 0.5) should still be in the center of this new crop.
//         let expected_x = (0.5 * 1.0 + 0.0 - 0.25) / 0.5;
//         let expected_y = (0.5 * 1.0 + 0.0 - 0.25) / 0.5;

//         assert!((new_normalized.x - expected_x).abs() < f64::EPSILON);
//         assert!((new_normalized.y - expected_y).abs() < f64::EPSILON);
//         assert_eq!(new_normalized.crop_position(), cropped_position);
//         assert_eq!(new_normalized.crop_size(), cropped_size);
//     }

//     #[test]
//     fn test_with_crop_top_left_of_crop() {
//         let display = mock_display();

//         let cropped_position = LogicalPosition::new(0.25, 0.25);
//         let cropped_size = LogicalSize::new(0.5, 0.5);

//         let original_normalized_at_crop_tl = NormalizedCursorPosition {
//             x: 0.25,
//             y: 0.25,
//             crop_position: LogicalPosition::new(0.0, 0.0),
//             crop_size: LogicalSize::new(1.0, 1.0),
//             display,
//         };

//         let new_normalized =
//             original_normalized_at_crop_tl.with_crop(cropped_position, cropped_size);

//         // The point that was at the top-left of the crop in the original space
//         // should now be at (0.0, 0.0) in the new cropped space.
//         assert!((new_normalized.x - 0.0).abs() < f64::EPSILON);
//         assert!((new_normalized.y - 0.0).abs() < f64::EPSILON);
//         assert_eq!(new_normalized.crop_position(), cropped_position);
//         assert_eq!(new_normalized.crop_size(), cropped_size);
//     }

//     #[test]
//     fn test_with_crop_bottom_right_of_crop() {
//         let display = mock_display();

//         let cropped_position = LogicalPosition::new(0.25, 0.25);
//         let cropped_size = LogicalSize::new(0.5, 0.5);

//         let original_normalized_at_crop_br = NormalizedCursorPosition {
//             x: 0.75,
//             y: 0.75,
//             crop_position: LogicalPosition::new(0.0, 0.0),
//             crop_size: LogicalSize::new(1.0, 1.0),
//             display,
//         };

//         let new_normalized =
//             original_normalized_at_crop_br.with_crop(cropped_position, cropped_size);

//         // The point that was at the bottom-right of the crop in the original space
//         // should now be at (1.0, 1.0) in the new cropped space.
//         assert!((new_normalized.x - 1.0).abs() < f64::EPSILON);
//         assert!((new_normalized.y - 1.0).abs() < f64::EPSILON);
//         assert_eq!(new_normalized.crop_position(), cropped_position);
//         assert_eq!(new_normalized.crop_size(), cropped_size);
//     }

//     #[test]
//     fn test_with_crop_from_existing_crop() {
//         let display = mock_display();
//         let original_normalized = NormalizedCursorPosition {
//             x: 0.5, // This 0.5 is within the first crop
//             y: 0.5, // This 0.5 is within the first crop
//             crop_position: LogicalPosition::new(0.1, 0.1),
//             crop_size: LogicalSize::new(0.8, 0.8),
//             display,
//         };

//         // The raw position of the cursor is 0.5 within the 0.1 to 0.9 range.
//         // Raw x = 0.5 * 0.8 + 0.1 = 0.4 + 0.1 = 0.5
//         // Raw y = 0.5 * 0.8 + 0.1 = 0.4 + 0.1 = 0.5

//         let second_crop_position = LogicalPosition::new(0.2, 0.2);
//         let second_crop_size = LogicalSize::new(0.6, 0.6);

//         // The second crop is from 0.2 to 0.8 in the original space.
//         // The raw position is (0.5, 0.5).
//         // In the second crop space, this should be:
//         // x = (0.5 - 0.2) / 0.6 = 0.3 / 0.6 = 0.5
//         // y = (0.5 - 0.2) / 0.6 = 0.3 / 0.6 = 0.5

//         let new_normalized = original_normalized.with_crop(second_crop_position, second_crop_size);

//         assert!((new_normalized.x - 0.5).abs() < f64::EPSILON);
//         assert!((new_normalized.y - 0.5).abs() < f64::EPSILON);
//         assert_eq!(
//             new_normalized.crop_position(),
//             LogicalPosition::new(0.2, 0.2)
//         );
//         assert_eq!(new_normalized.crop_size(), LogicalSize::new(0.6, 0.6));
//     }
// }
