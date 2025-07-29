#[cfg(test)]
mod tests {
    use super::super::cursor_svg::*;

    #[test]
    fn test_arrow_cursor_detection() {
        // Create a simple arrow pattern: mostly pixels in top-left
        let width = 32;
        let height = 32;
        let mut image_data = vec![0u8; (width * height * 4) as usize];

        // Add some pixels in the top-left area to simulate arrow
        for y in 0..height / 3 {
            for x in 0..width / 3 {
                let idx = ((y * width + x) * 4) as usize;
                if idx + 3 < image_data.len() {
                    image_data[idx] = 0; // R
                    image_data[idx + 1] = 0; // G
                    image_data[idx + 2] = 0; // B
                    image_data[idx + 3] = 255; // A (opaque)
                }
            }
        }

        let detected = CursorType::detect_from_image(&image_data, width, height);
        assert_eq!(detected, Some(CursorType::Arrow));
    }

    #[test]
    fn test_ibeam_cursor_detection() {
        // Create a vertical line pattern for I-beam
        let width = 16;
        let height = 32;
        let mut image_data = vec![0u8; (width * height * 4) as usize];

        // Add vertical line in center
        let center_x = width / 2;
        for y in 0..height {
            for x in center_x.saturating_sub(1)..=center_x + 1 {
                let idx = ((y * width + x) * 4) as usize;
                if idx + 3 < image_data.len() {
                    image_data[idx] = 0; // R
                    image_data[idx + 1] = 0; // G
                    image_data[idx + 2] = 0; // B
                    image_data[idx + 3] = 255; // A (opaque)
                }
            }
        }

        let detected = CursorType::detect_from_image(&image_data, width, height);
        assert_eq!(detected, Some(CursorType::IBeam));
    }

    #[test]
    fn test_crosshair_cursor_detection() {
        // Create a cross pattern
        let width = 24;
        let height = 24;
        let mut image_data = vec![0u8; (width * height * 4) as usize];

        let center_x = width / 2;
        let center_y = height / 2;

        // Horizontal line
        for x in 0..width {
            let idx = ((center_y * width + x) * 4) as usize;
            if idx + 3 < image_data.len() {
                image_data[idx + 3] = 255; // A (opaque)
            }
        }

        // Vertical line
        for y in 0..height {
            let idx = ((y * width + center_x) * 4) as usize;
            if idx + 3 < image_data.len() {
                image_data[idx + 3] = 255; // A (opaque)
            }
        }

        let detected = CursorType::detect_from_image(&image_data, width, height);
        assert_eq!(detected, Some(CursorType::Crosshair));
    }

    #[test]
    fn test_hand_cursor_detection() {
        // Create a pattern with more pixels in bottom half (typical of hand cursors)
        let width = 24;
        let height = 24;
        let mut image_data = vec![0u8; (width * height * 4) as usize];

        let mid_y = height / 2;

        // Add more pixels in the bottom half
        for y in mid_y..height {
            for x in 4..width - 4 {
                let idx = ((y * width + x) * 4) as usize;
                if idx + 3 < image_data.len() {
                    image_data[idx] = 0; // R
                    image_data[idx + 1] = 0; // G
                    image_data[idx + 2] = 0; // B
                    image_data[idx + 3] = 255; // A (opaque)
                }
            }
        }

        // Add some pixels in top half but fewer
        for y in 0..mid_y / 2 {
            for x in 8..width - 8 {
                let idx = ((y * width + x) * 4) as usize;
                if idx + 3 < image_data.len() {
                    image_data[idx + 3] = 255; // A (opaque)
                }
            }
        }

        let detected = CursorType::detect_from_image(&image_data, width, height);
        assert_eq!(detected, Some(CursorType::PointingHand));
    }

    #[test]
    fn test_resize_cursor_detection() {
        // Create a pattern with corner pixels (typical of resize cursors)
        let width = 24;
        let height = 24;
        let mut image_data = vec![0u8; (width * height * 4) as usize];

        // Add pixels in corners
        let corner_size = width / 4;

        // Top-left corner
        for y in 0..corner_size {
            for x in 0..corner_size {
                let idx = ((y * width + x) * 4) as usize;
                if idx + 3 < image_data.len() {
                    image_data[idx + 3] = 255; // A (opaque)
                }
            }
        }

        // Bottom-right corner
        for y in (height - corner_size)..height {
            for x in (width - corner_size)..width {
                let idx = ((y * width + x) * 4) as usize;
                if idx + 3 < image_data.len() {
                    image_data[idx + 3] = 255; // A (opaque)
                }
            }
        }

        let detected = CursorType::detect_from_image(&image_data, width, height);
        assert_eq!(detected, Some(CursorType::ResizeNWSE));
    }

    #[test]
    fn test_unknown_cursor_pattern() {
        // Create a random pattern that shouldn't match any known cursor
        let width = 32;
        let height = 32;
        let mut image_data = vec![0u8; (width * height * 4) as usize];

        // Add a few random pixels
        for i in (0..100).step_by(10) {
            if i * 4 + 3 < image_data.len() {
                image_data[i * 4 + 3] = 255; // A (opaque)
            }
        }

        let detected = CursorType::detect_from_image(&image_data, width, height);
        assert_eq!(detected, None);
    }

    #[test]
    fn test_empty_image() {
        // Test with completely transparent image
        let width = 32;
        let height = 32;
        let image_data = vec![0u8; (width * height * 4) as usize]; // All transparent

        let detected = CursorType::detect_from_image(&image_data, width, height);
        assert_eq!(detected, None);
    }

    #[test]
    fn test_svg_loading() {
        // Test that we can load SVG content for all cursor types
        for cursor_type in [
            CursorType::Arrow,
            CursorType::IBeam,
            CursorType::Crosshair,
            CursorType::PointingHand,
            CursorType::ResizeNWSE,
            CursorType::ResizeEW,
        ] {
            let svg_content = load_cursor_svg(&cursor_type);
            assert!(
                svg_content.is_some(),
                "Failed to load SVG for {:?}",
                cursor_type
            );

            if let Some(content) = svg_content {
                assert!(
                    !content.is_empty(),
                    "SVG content is empty for {:?}",
                    cursor_type
                );
                // Basic SVG validation
                let content_str = String::from_utf8_lossy(&content);
                assert!(
                    content_str.contains("<svg"),
                    "Invalid SVG content for {:?}",
                    cursor_type
                );
                assert!(
                    content_str.contains("</svg>"),
                    "Invalid SVG content for {:?}",
                    cursor_type
                );
            }
        }
    }

    #[test]
    fn test_cursor_pattern_edge_cases() {
        // Test with very small images
        let width = 4;
        let height = 4;
        let mut image_data = vec![0u8; (width * height * 4) as usize];

        // Fill with opaque pixels
        for i in 0..image_data.len() {
            if i % 4 == 3 {
                image_data[i] = 255; // Alpha channel
            }
        }

        let detected = CursorType::detect_from_image(&image_data, width, height);
        // Should not crash and return None for very small images
        assert_eq!(detected, None);
    }

    #[test]
    fn test_cursor_pattern_with_invalid_data() {
        // Test with insufficient data
        let width = 32;
        let height = 32;
        let image_data = vec![0u8; 10]; // Much smaller than required

        let detected = CursorType::detect_from_image(&image_data, width, height);
        // Should handle gracefully and return None
        assert_eq!(detected, None);
    }
}
