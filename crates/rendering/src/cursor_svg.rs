use std::{borrow::Cow, path::Path};

use cap_project::XY;
use image::GenericImageView;

static CURSOR_ARROW: &'static [u8] = include_bytes!("../assets/cursors/arrow.svg");
static CURSOR_IBEAM: &'static [u8] = include_bytes!("../assets/cursors/ibeam.svg");
static CURSOR_CROSSHAIR: &'static [u8] = include_bytes!("../assets/cursors/crosshair.svg");
static CURSOR_POINTING_HAND: &'static [u8] = include_bytes!("../assets/cursors/pointing-hand.svg");
static CURSOR_RESIZE_NWSE: &'static [u8] = include_bytes!("../assets/cursors/resize-nwse.svg");
static CURSOR_RESIZE_EW: &'static [u8] = include_bytes!("../assets/cursors/resize-ew.svg");

/// The type of cursor to use
#[derive(Debug, Clone, Eq, PartialEq, Hash)]
pub enum CursorType {
    Arrow,
    IBeam,
    Crosshair,
    PointingHand,
    ResizeNWSE,
    ResizeEW,
}

impl CursorType {
    pub fn load(&self) -> Cow<'static, [u8]> {
        match self {
            CursorType::Arrow => Cow::Borrowed(CURSOR_ARROW),
            CursorType::IBeam => Cow::Borrowed(CURSOR_IBEAM),
            CursorType::Crosshair => Cow::Borrowed(CURSOR_CROSSHAIR),
            CursorType::PointingHand => Cow::Borrowed(CURSOR_POINTING_HAND),
            CursorType::ResizeNWSE => Cow::Borrowed(CURSOR_RESIZE_NWSE),
            CursorType::ResizeEW => Cow::Borrowed(CURSOR_RESIZE_EW),
        }
    }

    pub fn get_hotspot(&self) -> XY<f32> {
        match self {
            CursorType::Arrow => XY::new(0.1, 0.1),     // Top-left point
            CursorType::IBeam => XY::new(0.5, 0.5),     // Center
            CursorType::Crosshair => XY::new(0.5, 0.5), // Center
            CursorType::PointingHand => XY::new(0.3, 0.1), // Finger tip
            CursorType::ResizeNWSE => XY::new(0.5, 0.5), // Center
            CursorType::ResizeEW => XY::new(0.5, 0.5),  // Center
        }
    }

    /// Detect cursor type from image data (simplified heuristic approach)
    /// In a real implementation, this could use more sophisticated image analysis
    pub fn detect_from_image(image_data: &[u8], width: u32, height: u32) -> Option<Self> {
        // For now, we'll use simple heuristics based on size and basic pattern detection
        // This is a placeholder - in production you might want more sophisticated detection

        // Arrow cursor is typically around 32x32 or similar
        if width <= 40 && height <= 40 {
            // Simple pattern matching - this could be made more sophisticated
            if Self::matches_arrow_pattern(image_data, width, height) {
                return Some(CursorType::Arrow);
            }
        }

        // I-beam cursors are typically thin and tall
        if width < height && width <= 20 && height >= 20 {
            if Self::matches_ibeam_pattern(image_data, width, height) {
                return Some(CursorType::IBeam);
            }
        }

        // Crosshair cursors are typically square and have cross pattern
        if (width as i32 - height as i32).abs() <= 5 && width >= 20 && width <= 40 {
            if Self::matches_crosshair_pattern(image_data, width, height) {
                return Some(CursorType::Crosshair);
            }
        }

        // Pointing hand cursors are typically wider and have a specific shape
        if width >= 20 && height >= 20 && width <= 40 && height <= 40 {
            if Self::matches_hand_pattern(image_data, width, height) {
                return Some(CursorType::PointingHand);
            }
        }

        // Resize cursors - typically have arrow patterns
        if width >= 16 && height >= 16 && width <= 40 && height <= 40 {
            if Self::matches_resize_pattern(image_data, width, height) {
                // For simplicity, default to diagonal resize
                // More sophisticated detection could distinguish between different resize types
                return Some(CursorType::ResizeNWSE);
            }
        }

        None
    }

    /// Simple pattern matching for arrow cursor
    /// Look for typical arrow shape - pointed top-left, wider bottom-right
    fn matches_arrow_pattern(image_data: &[u8], width: u32, height: u32) -> bool {
        // This is a very simplified check
        // In practice, you'd want more sophisticated pattern recognition

        if image_data.len() < (width * height * 4) as usize {
            return false;
        }

        // Check if there's a diagonal pattern from top-left
        let mut non_transparent_pixels = 0;
        let mut top_left_pixels = 0;

        for y in 0..height {
            for x in 0..width {
                let idx = ((y * width + x) * 4) as usize;
                if idx + 3 < image_data.len() {
                    let alpha = image_data[idx + 3];
                    if alpha > 128 {
                        // Not transparent
                        non_transparent_pixels += 1;
                        if x <= width / 3 && y <= height / 3 {
                            top_left_pixels += 1;
                        }
                    }
                }
            }
        }

        // Arrow should have most pixels in top-left area
        non_transparent_pixels > 0 && top_left_pixels as f32 / non_transparent_pixels as f32 > 0.3
    }

    /// Simple pattern matching for I-beam cursor
    fn matches_ibeam_pattern(image_data: &[u8], width: u32, height: u32) -> bool {
        if image_data.len() < (width * height * 4) as usize {
            return false;
        }

        // I-beam should have pixels mostly in vertical center column
        let center_x = width / 2;
        let mut center_column_pixels = 0;
        let mut total_pixels = 0;

        for y in 0..height {
            for x in 0..width {
                let idx = ((y * width + x) * 4) as usize;
                if idx + 3 < image_data.len() {
                    let alpha = image_data[idx + 3];
                    if alpha > 128 {
                        total_pixels += 1;
                        if (x as i32 - center_x as i32).abs() <= 2 {
                            center_column_pixels += 1;
                        }
                    }
                }
            }
        }

        total_pixels > 0 && center_column_pixels as f32 / total_pixels as f32 > 0.6
    }

    /// Simple pattern matching for crosshair cursor
    fn matches_crosshair_pattern(image_data: &[u8], width: u32, height: u32) -> bool {
        if image_data.len() < (width * height * 4) as usize {
            return false;
        }

        let center_x = width / 2;
        let center_y = height / 2;
        let mut cross_pixels = 0;
        let mut total_pixels = 0;

        for y in 0..height {
            for x in 0..width {
                let idx = ((y * width + x) * 4) as usize;
                if idx + 3 < image_data.len() {
                    let alpha = image_data[idx + 3];
                    if alpha > 128 {
                        total_pixels += 1;
                        // Check if pixel is on horizontal or vertical line through center
                        if (x as i32 - center_x as i32).abs() <= 2
                            || (y as i32 - center_y as i32).abs() <= 2
                        {
                            cross_pixels += 1;
                        }
                    }
                }
            }
        }

        total_pixels > 0 && cross_pixels as f32 / total_pixels as f32 > 0.5
    }

    /// Simple pattern matching for pointing hand cursor
    fn matches_hand_pattern(image_data: &[u8], width: u32, height: u32) -> bool {
        if image_data.len() < (width * height * 4) as usize {
            return false;
        }

        // Hand cursors typically have more pixels in the bottom half
        let mut top_half_pixels = 0;
        let mut bottom_half_pixels = 0;
        let mid_y = height / 2;

        for y in 0..height {
            for x in 0..width {
                let idx = ((y * width + x) * 4) as usize;
                if idx + 3 < image_data.len() {
                    let alpha = image_data[idx + 3];
                    if alpha > 128 {
                        if y < mid_y {
                            top_half_pixels += 1;
                        } else {
                            bottom_half_pixels += 1;
                        }
                    }
                }
            }
        }

        // Hand cursor should have more pixels in bottom half
        bottom_half_pixels > top_half_pixels && bottom_half_pixels > 50
    }

    /// Simple pattern matching for resize cursors
    /// Look for arrow-like patterns in corners or edges
    fn matches_resize_pattern(image_data: &[u8], width: u32, height: u32) -> bool {
        if image_data.len() < (width * height * 4) as usize {
            return false;
        }

        // Resize cursors typically have arrow patterns pointing in opposite directions
        let mut corner_pixels = 0;
        let mut edge_pixels = 0;
        let mut total_pixels = 0;

        for y in 0..height {
            for x in 0..width {
                let idx = ((y * width + x) * 4) as usize;
                if idx + 3 < image_data.len() {
                    let alpha = image_data[idx + 3];
                    if alpha > 128 {
                        total_pixels += 1;

                        // Check if pixel is in corners (typical for resize cursors)
                        let is_corner = (x < width / 4 && y < height / 4)
                            || (x > 3 * width / 4 && y > 3 * height / 4)
                            || (x < width / 4 && y > 3 * height / 4)
                            || (x > 3 * width / 4 && y < height / 4);

                        if is_corner {
                            corner_pixels += 1;
                        }

                        // Check if pixel is on edges (for line-based resize cursors)
                        let is_edge = x < 2 || x > width - 3 || y < 2 || y > height - 3;
                        if is_edge {
                            edge_pixels += 1;
                        }
                    }
                }
            }
        }

        // Resize cursors should have significant corner or edge concentration
        total_pixels > 20
            && (corner_pixels as f32 / total_pixels as f32 > 0.3
                || edge_pixels as f32 / total_pixels as f32 > 0.6)
    }
}

/// Analyze a cursor image and try to detect its type
pub fn analyze_cursor_image(image_path: &Path) -> Option<CursorType> {
    // Load the image and analyze it
    if let Ok(img) = image::open(image_path) {
        let rgba = img.to_rgba8();
        let (width, height) = img.dimensions();
        CursorType::detect_from_image(&rgba.into_raw(), width, height)
    } else {
        None
    }
}
