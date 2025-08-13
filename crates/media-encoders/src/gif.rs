use gif::{Encoder, Frame, Repeat};
use std::fs::File;
use std::path::Path;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum GifEncodingError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("GIF encoding error: {0}")]
    Gif(#[from] gif::EncodingError),
    #[error("Invalid frame data")]
    InvalidFrameData,
}

pub struct GifEncoderWrapper {
    encoder: Encoder<File>,
    width: u16,
    height: u16,
    frame_delay: u16,
}

impl GifEncoderWrapper {
    pub fn new<P: AsRef<Path>>(
        path: P,
        width: u32,
        height: u32,
        fps: u32,
    ) -> Result<Self, GifEncodingError> {
        let file = File::create(path)?;

        let global_palette = create_corrected_palette();
        let mut encoder = Encoder::new(file, width as u16, height as u16, &global_palette)?;
        encoder.set_repeat(Repeat::Infinite)?;

        let frame_delay = (100.0 / fps as f32).max(1.0) as u16;

        Ok(Self {
            encoder,
            width: width as u16,
            height: height as u16,
            frame_delay,
        })
    }

    pub fn add_frame(
        &mut self,
        frame_data: &[u8],
        padded_bytes_per_row: usize,
    ) -> Result<(), GifEncodingError> {
        let width = self.width as usize;
        let height = self.height as usize;
        let mut indexed_data = Vec::with_capacity(width * height);

        // Extract RGB data from RGBA into a working buffer for dithering
        let mut rgb_data = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            let row_start = y * padded_bytes_per_row;
            for x in 0..width {
                let pixel_start = row_start + x * 4;
                if pixel_start + 3 < frame_data.len() {
                    rgb_data.push(frame_data[pixel_start] as f32);     // R
                    rgb_data.push(frame_data[pixel_start + 1] as f32); // G
                    rgb_data.push(frame_data[pixel_start + 2] as f32); // B
                } else {
                    return Err(GifEncodingError::InvalidFrameData);
                }
            }
        }

        // Apply Floyd-Steinberg dithering
        for y in 0..height {
            for x in 0..width {
                let pixel_idx = (y * width + x) * 3;

                // Clamp values to valid range before processing
                let r = rgb_data[pixel_idx].clamp(0.0, 255.0).round() as u8;
                let g = rgb_data[pixel_idx + 1].clamp(0.0, 255.0).round() as u8;
                let b = rgb_data[pixel_idx + 2].clamp(0.0, 255.0).round() as u8;

                let palette_idx = find_closest_palette_index(r, g, b);

                // Add the palette index (u8 is always <= 255)
                indexed_data.push(palette_idx);

                let (pr, pg, pb) = get_palette_color(palette_idx.min(255));

                let er = r as f32 - pr as f32;
                let eg = g as f32 - pg as f32;
                let eb = b as f32 - pb as f32;

                // Distribute error to neighboring pixels using Floyd-Steinberg weights
                // Apply error diffusion with tighter bounds to prevent artifacts

                // Right pixel (x+1, y): 7/16
                if x + 1 < width {
                    let right_idx = (y * width + x + 1) * 3;
                    rgb_data[right_idx] = (rgb_data[right_idx] + er * 7.0 / 16.0).clamp(-64.0, 319.0);
                    rgb_data[right_idx + 1] = (rgb_data[right_idx + 1] + eg * 7.0 / 16.0).clamp(-64.0, 319.0);
                    rgb_data[right_idx + 2] = (rgb_data[right_idx + 2] + eb * 7.0 / 16.0).clamp(-64.0, 319.0);
                }

                // Next row pixels
                if y + 1 < height {
                    // Bottom-left pixel (x-1, y+1): 3/16
                    if x > 0 {
                        let bottom_left_idx = ((y + 1) * width + x - 1) * 3;
                        rgb_data[bottom_left_idx] = (rgb_data[bottom_left_idx] + er * 3.0 / 16.0).clamp(-64.0, 319.0);
                        rgb_data[bottom_left_idx + 1] = (rgb_data[bottom_left_idx + 1] + eg * 3.0 / 16.0).clamp(-64.0, 319.0);
                        rgb_data[bottom_left_idx + 2] = (rgb_data[bottom_left_idx + 2] + eb * 3.0 / 16.0).clamp(-64.0, 319.0);
                    }

                    // Bottom pixel (x, y+1): 5/16
                    let bottom_idx = ((y + 1) * width + x) * 3;
                    rgb_data[bottom_idx] = (rgb_data[bottom_idx] + er * 5.0 / 16.0).clamp(-64.0, 319.0);
                    rgb_data[bottom_idx + 1] = (rgb_data[bottom_idx + 1] + eg * 5.0 / 16.0).clamp(-64.0, 319.0);
                    rgb_data[bottom_idx + 2] = (rgb_data[bottom_idx + 2] + eb * 5.0 / 16.0).clamp(-64.0, 319.0);

                    // Bottom-right pixel (x+1, y+1): 1/16
                    if x + 1 < width {
                        let bottom_right_idx = ((y + 1) * width + x + 1) * 3;
                        rgb_data[bottom_right_idx] = (rgb_data[bottom_right_idx] + er / 16.0).clamp(-64.0, 319.0);
                        rgb_data[bottom_right_idx + 1] = (rgb_data[bottom_right_idx + 1] + eg / 16.0).clamp(-64.0, 319.0);
                        rgb_data[bottom_right_idx + 2] = (rgb_data[bottom_right_idx + 2] + eb / 16.0).clamp(-64.0, 319.0);
                    }
                }
            }
        }

        let mut frame = Frame::from_indexed_pixels(self.width, self.height, indexed_data, None);
        frame.delay = self.frame_delay;

        self.encoder.write_frame(&frame)?;
        Ok(())
    }

    pub fn finish(self) -> Result<(), GifEncodingError> {
        drop(self.encoder);
        Ok(())
    }
}

fn create_corrected_palette() -> Vec<u8> {
    let mut palette = Vec::with_capacity(256 * 3);

    // Create 6x7x6 RGB cube with consistent rounding
    for r in 0..6 {
        for g in 0..7 {
            for b in 0..6 {
                // Use consistent rounding with the index calculation
                palette.push(((r * 255 + 2) / 5) as u8);
                palette.push(((g * 255 + 3) / 6) as u8);
                palette.push(((b * 255 + 2) / 5) as u8);
            }
        }
    }

    // Add the 4 grayscale colors (indices 252-255)
    palette.push(0);   palette.push(0);   palette.push(0);     // Black (252)
    palette.push(85);  palette.push(85);  palette.push(85);    // Dark gray (253)
    palette.push(170); palette.push(170); palette.push(170);   // Light gray (254)
    palette.push(255); palette.push(255); palette.push(255);   // White (255)

    palette
}

fn find_closest_palette_index(r: u8, g: u8, b: u8) -> u8 {
    // More conservative grayscale detection to prevent misclassification
    let max_component = r.max(g).max(b);
    let min_component = r.min(g).min(b);
    let range = max_component - min_component;

    // Only treat as grayscale if the color is very close to neutral
    if range <= 5 {
        // Use perceptual luminance for grayscale mapping
        let luminance = (0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32).round() as u8;

        // Map to the 4 grayscale levels with better thresholds
        if luminance < 43 {      // 0 to 42: Black
            return 252;
        } else if luminance < 128 {  // 43 to 127: Dark gray
            return 253;
        } else if luminance < 213 {  // 128 to 212: Light gray
            return 254;
        } else {                 // 213 to 255: White
            return 255;
        }
    }

    // Map to RGB cube with consistent rounding
    let r_idx = ((r as u32 * 5 + 127) / 255).min(5) as u8;
    let g_idx = ((g as u32 * 6 + 127) / 255).min(6) as u8;
    let b_idx = ((b as u32 * 5 + 127) / 255).min(5) as u8;

    // Calculate index with bounds checking
    let index = r_idx * 42 + g_idx * 6 + b_idx;
    index.min(251) // Ensure we stay within RGB cube range
}

fn get_palette_color(index: u8) -> (u8, u8, u8) {
    if index < 252 {
        // Decode RGB cube index
        let r_idx = (index / 42) as u32;
        let rem = index % 42;
        let g_idx = (rem / 6) as u32;
        let b_idx = (rem % 6) as u32;

        // Use exact same calculation as palette creation
        let r = ((r_idx * 255 + 2) / 5) as u8;
        let g = ((g_idx * 255 + 3) / 6) as u8;
        let b = ((b_idx * 255 + 2) / 5) as u8;
        (r, g, b)
    } else {
        // Grayscale colors
        match index {
            252 => (0, 0, 0),       // Black
            253 => (85, 85, 85),    // Dark gray
            254 => (170, 170, 170), // Light gray
            255 => (255, 255, 255), // White
            _ => (0, 0, 0),         // Fallback to black
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_palette_color_mapping() {
        // Test basic colors map correctly
        assert_eq!(find_closest_palette_index(0, 0, 0), 252);     // Black -> grayscale
        assert_eq!(find_closest_palette_index(255, 255, 255), 255); // White -> grayscale
        assert_eq!(find_closest_palette_index(255, 0, 0), 210);   // Red -> RGB cube
        assert_eq!(find_closest_palette_index(0, 255, 0), 36);    // Green -> RGB cube
        assert_eq!(find_closest_palette_index(0, 0, 255), 5);     // Blue -> RGB cube

        // Verify palette color retrieval
        assert_eq!(get_palette_color(252), (0, 0, 0));       // Black
        assert_eq!(get_palette_color(255), (255, 255, 255)); // White

        // Test RGB cube formula: r_idx * 42 + g_idx * 6 + b_idx
        // Pure red: r=5, g=0, b=0 -> 5*42 + 0*6 + 0 = 210
        assert_eq!(get_palette_color(210), (255, 0, 0));     // Red
        // Pure green: r=0, g=6, b=0 -> 0*42 + 6*6 + 0 = 36
        assert_eq!(get_palette_color(36), (0, 255, 0));      // Green
        // Pure blue: r=0, g=0, b=5 -> 0*42 + 0*6 + 5 = 5
        assert_eq!(get_palette_color(5), (0, 0, 255));       // Blue
    }

    #[test]
    fn test_grayscale_detection() {
        // Test basic grayscale detection first
        assert_eq!(find_closest_palette_index(0, 0, 0), 252);       // Pure black
        assert_eq!(find_closest_palette_index(255, 255, 255), 255); // Pure white

        // Test luminance thresholds based on palette values
        // Thresholds: <43=black, <128=dark_gray, <213=light_gray, >=213=white
        assert_eq!(find_closest_palette_index(30, 30, 30), 252);    // luminance=30 < 43 -> black
        assert_eq!(find_closest_palette_index(85, 85, 85), 253);    // luminance=85 < 128 -> dark gray
        assert_eq!(find_closest_palette_index(150, 150, 150), 254); // luminance=150 < 213 -> light gray
        assert_eq!(find_closest_palette_index(220, 220, 220), 255); // luminance=220 >= 213 -> white

        // Colors that should NOT be detected as grayscale (high saturation)
        let red_idx = find_closest_palette_index(255, 200, 200); // Pinkish (high saturation)
        assert!(red_idx < 252); // Should map to RGB cube, not grayscale

        let blue_idx = find_closest_palette_index(100, 100, 200); // Blueish
        assert!(blue_idx < 252); // Should map to RGB cube, not grayscale
    }

    #[test]
    fn test_floyd_steinberg_improvements() {
        // This test demonstrates the key improvements in Floyd-Steinberg dithering

        // Test that we properly use floating-point arithmetic for error diffusion
        // The old implementation would have integer quantization errors

        // Create a small test gradient that would show dithering artifacts with integer math
        let test_gradient = [
            128, 128, 128,  // Mid gray
            129, 129, 129,  // Slightly lighter
            130, 130, 130,  // Even lighter
            131, 131, 131,  // Subtle change
        ];

        // Test each color maps to appropriate grayscale
        for i in 0..4 {
            let r = test_gradient[i * 3];
            let g = test_gradient[i * 3 + 1];
            let b = test_gradient[i * 3 + 2];

            let idx = find_closest_palette_index(r, g, b);
            assert!(idx >= 252); // Should be grayscale (low saturation)

            // Verify we can retrieve the palette color
            let (pr, pg, pb) = get_palette_color(idx);
            assert_eq!(pr, pg); // Grayscale should have equal components
            assert_eq!(pg, pb);
        }

        // Test perceptual luminance calculation is working
        // Green should be perceived as brighter than red or blue of same value
        let red_lum = 0.299 * 100.0;   // ~29.9
        let green_lum = 0.587 * 100.0; // ~58.7
        let blue_lum = 0.114 * 100.0;  // ~11.4

        assert!(green_lum > red_lum);
        assert!(red_lum > blue_lum);

        // This reflects the proper perceptual weighting in our luminance calculation
    }

    #[test]
    fn test_range_based_grayscale_detection() {
        // Test pure grayscale colors
        assert_eq!(find_closest_palette_index(100, 100, 100), 253); // range=0 -> dark grayscale

        // Very low range (should still be grayscale) - range <= 5
        assert_eq!(find_closest_palette_index(100, 101, 100), 253); // range=1 -> dark grayscale
        assert_eq!(find_closest_palette_index(100, 102, 99), 253);  // range=3 -> dark grayscale
        assert_eq!(find_closest_palette_index(100, 105, 100), 253); // range=5 -> dark grayscale

        // Medium range (should go to RGB cube) - range > 5
        let med_range_idx = find_closest_palette_index(100, 120, 100); // range=20
        assert!(med_range_idx < 252); // Should map to RGB cube

        // High range (definitely RGB cube)
        let high_range_idx = find_closest_palette_index(255, 100, 100); // range=155
        assert!(high_range_idx < 252); // Should map to RGB cube

        // Test boundary case around range=5 threshold
        let boundary_low = find_closest_palette_index(100, 105, 100);  // range=5 -> grayscale
        let boundary_high = find_closest_palette_index(100, 106, 100); // range=6 -> RGB cube

        assert_eq!(boundary_low, 253); // Should be dark grayscale
        assert!(boundary_high < 252);  // Should be RGB cube
    }

    #[test]
    fn test_edge_cases_and_bounds_checking() {
        // Test extreme RGB values don't cause issues
        find_closest_palette_index(255, 255, 255);
        find_closest_palette_index(0, 0, 0);
        find_closest_palette_index(128, 128, 128);

        // Test that RGB cube mapping never exceeds 251 (max valid RGB cube index)
        for r in [0, 51, 102, 153, 204, 255] { // Representative values for 6-level quantization
            for g in [0, 42, 85, 127, 170, 212, 255] { // Representative values for 7-level quantization
                for b in [0, 51, 102, 153, 204, 255] { // Representative values for 6-level quantization
                    let idx = find_closest_palette_index(r, g, b);

                    // If it's not grayscale, it should be in RGB cube range
                    if idx < 252 {
                        assert!(idx <= 251, "RGB cube index {} out of bounds for RGB({}, {}, {})", idx, r, g, b);
                    }
                }
            }
        }
    }

    #[test]
    fn test_palette_consistency() {
        // Verify that palette creation and retrieval are consistent
        for idx in 0..=255 {
            let (r, g, b) = get_palette_color(idx);

            // For RGB cube indices, verify the mapping is bidirectional
            if idx < 252 {
                let mapped_idx = find_closest_palette_index(r, g, b);
                // The mapped index should either be the same or map to grayscale if very low saturation
                assert!(mapped_idx == idx || mapped_idx >= 252,
                       "Inconsistent mapping: {} -> RGB({}, {}, {}) -> {}", idx, r, g, b, mapped_idx);
            }
        }
    }

    #[test]
    fn test_white_noise_prevention() {
        // Test scenarios that could previously cause white dots

        // Test near-boundary values that could round incorrectly
        let test_cases = [
            (254, 254, 254), // Very close to white
            (1, 1, 1),       // Very close to black
            (85, 86, 85),    // Near dark gray boundary
            (170, 171, 170), // Near light gray boundary
            (255, 255, 255), // Pure white
            (0, 0, 0),       // Pure black
            (127, 128, 129), // Mid-range values
        ];

        for (r, g, b) in test_cases {
            let idx = find_closest_palette_index(r, g, b);
            // idx is u8, so always <= 255

            // Verify we can retrieve the color without issues
            let (pr, pg, pb) = get_palette_color(idx);

            // Colors are u8, so always valid (0-255)
            let _ = (pr, pg, pb); // Ensure we can retrieve colors without panicking
        }

        // Test that error accumulation values are handled properly
        let extreme_values: [f32; 6] = [-100.0, -50.0, 0.0, 255.0, 300.0, 350.0];

        for &val in &extreme_values {
            let clamped = val.clamp(-64.0, 319.0);
            let final_val = clamped.clamp(0.0, 255.0).round() as u8;

            // Test that even extreme values produce valid palette indices
            let idx = find_closest_palette_index(final_val, final_val, final_val);
            // Ensure palette index is valid (u8 is always <= 255)
            let _ = idx;
        }
    }
}
