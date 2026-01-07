pub const H264_MAX_DIMENSION: u32 = 4096;

pub fn calculate_gpu_compatible_size(
    width: u32,
    height: u32,
    max_dimension: u32,
) -> Option<(u32, u32)> {
    let needs_downscale = width > max_dimension || height > max_dimension;
    let needs_even_adjustment = width % 2 != 0 || height % 2 != 0;

    if !needs_downscale && !needs_even_adjustment {
        return None;
    }

    if !needs_downscale {
        return Some((ensure_even(width), ensure_even(height)));
    }

    let aspect_ratio = width as f64 / height as f64;

    let (target_width, target_height) = if width >= height {
        let mut target_width = max_dimension.min(width);
        let mut target_height = (target_width as f64 / aspect_ratio).round() as u32;

        if target_height > max_dimension {
            target_height = max_dimension;
            target_width = (target_height as f64 * aspect_ratio).round() as u32;
            target_width = target_width.min(max_dimension);
        }

        (target_width, target_height)
    } else {
        let mut target_height = max_dimension.min(height);
        let mut target_width = (target_height as f64 * aspect_ratio).round() as u32;

        if target_width > max_dimension {
            target_width = max_dimension;
            target_height = (target_width as f64 / aspect_ratio).round() as u32;
            target_height = target_height.min(max_dimension);
        }

        (target_width, target_height)
    };

    let final_width = ensure_even(target_width);
    let final_height = ensure_even(target_height);

    tracing::debug!(
        input_width = width,
        input_height = height,
        output_width = final_width,
        output_height = final_height,
        max_dimension = max_dimension,
        "Studio mode auto-downscaling applied for hardware encoder compatibility"
    );

    Some((final_width, final_height))
}

fn ensure_even(value: u32) -> u32 {
    let adjusted = value - (value % 2);
    if adjusted == 0 { 2 } else { adjusted }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_valid_output(result: Option<(u32, u32)>, max_dim: u32) {
        if let Some((w, h)) = result {
            assert!(w <= max_dim, "Width {} exceeds max {}", w, max_dim);
            assert!(h <= max_dim, "Height {} exceeds max {}", h, max_dim);
            assert_eq!(w % 2, 0, "Width {} is odd", w);
            assert_eq!(h % 2, 0, "Height {} is odd", h);
            assert!(w >= 2, "Width {} is too small", w);
            assert!(h >= 2, "Height {} is too small", h);
        }
    }

    fn assert_aspect_preserved(
        original_w: u32,
        original_h: u32,
        result_w: u32,
        result_h: u32,
        tolerance: f64,
    ) {
        let original_aspect = original_w as f64 / original_h as f64;
        let result_aspect = result_w as f64 / result_h as f64;
        assert!(
            (original_aspect - result_aspect).abs() < tolerance,
            "Aspect ratio changed too much: {} -> {}",
            original_aspect,
            result_aspect
        );
    }

    #[test]
    fn test_standard_resolutions_even_return_none() {
        assert_eq!(calculate_gpu_compatible_size(1280, 720, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(1920, 1080, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(2560, 1440, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(3840, 2160, 4096), None);
    }

    #[test]
    fn test_exactly_at_limit_returns_none() {
        assert_eq!(calculate_gpu_compatible_size(4096, 4096, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(4096, 2160, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(3840, 4096, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(4096, 2304, 4096), None);
    }

    #[test]
    fn test_ultrawide_21_9_resolutions() {
        assert_eq!(calculate_gpu_compatible_size(2560, 1080, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(3440, 1440, 4096), None);

        let result = calculate_gpu_compatible_size(5120, 2160, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_valid_output(result, 4096);
        assert_aspect_preserved(5120, 2160, w, h, 0.02);
    }

    #[test]
    fn test_super_ultrawide_32_9_resolutions() {
        assert_eq!(calculate_gpu_compatible_size(3840, 1080, 4096), None);

        let result = calculate_gpu_compatible_size(5120, 1440, 4096);
        assert!(result.is_some());
        assert_valid_output(result, 4096);

        let result = calculate_gpu_compatible_size(7680, 2160, 4096);
        assert!(result.is_some());
        assert_valid_output(result, 4096);
    }

    #[test]
    fn test_legacy_4_3_resolutions() {
        assert_eq!(calculate_gpu_compatible_size(1024, 768, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(1600, 1200, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(2048, 1536, 4096), None);
    }

    #[test]
    fn test_legacy_5_4_resolutions() {
        assert_eq!(calculate_gpu_compatible_size(1280, 1024, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(2560, 2048, 4096), None);
    }

    #[test]
    fn test_5k_landscape_downscales() {
        let result = calculate_gpu_compatible_size(5120, 2880, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_valid_output(result, 4096);
        assert_aspect_preserved(5120, 2880, w, h, 0.02);
    }

    #[test]
    fn test_8k_resolution_downscales() {
        let result = calculate_gpu_compatible_size(7680, 4320, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_valid_output(result, 4096);
        assert_aspect_preserved(7680, 4320, w, h, 0.02);
    }

    #[test]
    fn test_portrait_standard_resolutions() {
        assert_eq!(calculate_gpu_compatible_size(1080, 1920, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(1440, 2560, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(2160, 3840, 4096), None);
    }

    #[test]
    fn test_portrait_exceeding_limit() {
        let result = calculate_gpu_compatible_size(2880, 5120, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_valid_output(result, 4096);
        assert_aspect_preserved(2880, 5120, w, h, 0.02);

        let result = calculate_gpu_compatible_size(4320, 7680, 4096);
        assert!(result.is_some());
        assert_valid_output(result, 4096);
    }

    #[test]
    fn test_window_capture_odd_height() {
        let result = calculate_gpu_compatible_size(2560, 1055, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_eq!(w, 2560);
        assert_eq!(h, 1054);
        assert_valid_output(result, 4096);
    }

    #[test]
    fn test_window_capture_odd_width() {
        let result = calculate_gpu_compatible_size(1921, 1080, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_eq!(w, 1920);
        assert_eq!(h, 1080);
    }

    #[test]
    fn test_window_capture_both_odd() {
        let result = calculate_gpu_compatible_size(1921, 1081, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_eq!(w, 1920);
        assert_eq!(h, 1080);
    }

    #[test]
    fn test_window_capture_common_browser_sizes() {
        let browser_sizes = [
            (1903, 969),
            (1423, 800),
            (1279, 719),
            (800, 600),
            (1024, 768),
            (1366, 768),
            (1536, 864),
        ];

        for (w, h) in browser_sizes {
            let result = calculate_gpu_compatible_size(w, h, 4096);
            if w % 2 != 0 || h % 2 != 0 {
                assert!(result.is_some(), "Should adjust odd dimensions {}x{}", w, h);
            }
            assert_valid_output(result, 4096);
        }
    }

    #[test]
    fn test_small_window_captures() {
        let small_sizes = [(100, 100), (50, 50), (200, 150), (320, 240), (640, 480)];

        for (w, h) in small_sizes {
            let result = calculate_gpu_compatible_size(w, h, 4096);
            assert_valid_output(result, 4096);
        }
    }

    #[test]
    fn test_small_odd_dimensions() {
        let result = calculate_gpu_compatible_size(101, 101, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_eq!(w, 100);
        assert_eq!(h, 100);

        let result = calculate_gpu_compatible_size(51, 33, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_eq!(w, 50);
        assert_eq!(h, 32);
    }

    #[test]
    fn test_very_small_dimensions() {
        let result = calculate_gpu_compatible_size(3, 3, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_eq!(w, 2);
        assert_eq!(h, 2);

        let result = calculate_gpu_compatible_size(1, 1, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_eq!(w, 2);
        assert_eq!(h, 2);
    }

    #[test]
    fn test_ensure_even() {
        assert_eq!(ensure_even(100), 100);
        assert_eq!(ensure_even(101), 100);
        assert_eq!(ensure_even(1), 2);
        assert_eq!(ensure_even(0), 2);
        assert_eq!(ensure_even(2), 2);
        assert_eq!(ensure_even(3), 2);
        assert_eq!(ensure_even(4095), 4094);
        assert_eq!(ensure_even(4096), 4096);
    }

    #[test]
    fn test_just_over_limit() {
        let result = calculate_gpu_compatible_size(4097, 4097, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_valid_output(result, 4096);
        assert!(w <= 4096);
        assert!(h <= 4096);
    }

    #[test]
    fn test_one_dimension_over_limit() {
        let result = calculate_gpu_compatible_size(4097, 2160, 4096);
        assert!(result.is_some());
        assert_valid_output(result, 4096);

        let result = calculate_gpu_compatible_size(3840, 4097, 4096);
        assert!(result.is_some());
        assert_valid_output(result, 4096);
    }

    #[test]
    fn test_one_dimension_at_limit_other_odd() {
        let result = calculate_gpu_compatible_size(4096, 2161, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_eq!(w, 4096);
        assert_eq!(h, 2160);

        let result = calculate_gpu_compatible_size(4095, 2160, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_eq!(w, 4094);
        assert_eq!(h, 2160);
    }

    #[test]
    fn test_maximum_odd_dimensions_under_limit() {
        let result = calculate_gpu_compatible_size(4095, 4095, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_eq!(w, 4094);
        assert_eq!(h, 4094);
    }

    #[test]
    fn test_tall_narrow_window() {
        let result = calculate_gpu_compatible_size(400, 1200, 4096);
        assert_valid_output(result, 4096);

        let result = calculate_gpu_compatible_size(401, 1201, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_eq!(w, 400);
        assert_eq!(h, 1200);
    }

    #[test]
    fn test_wide_short_window() {
        let result = calculate_gpu_compatible_size(2000, 300, 4096);
        assert_valid_output(result, 4096);

        let result = calculate_gpu_compatible_size(2001, 301, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert_eq!(w, 2000);
        assert_eq!(h, 300);
    }

    #[test]
    fn test_extreme_aspect_ratios() {
        let result = calculate_gpu_compatible_size(100, 4000, 4096);
        assert_valid_output(result, 4096);

        let result = calculate_gpu_compatible_size(4000, 100, 4096);
        assert_valid_output(result, 4096);

        let result = calculate_gpu_compatible_size(101, 4001, 4096);
        assert!(result.is_some());
        assert_valid_output(result, 4096);
    }

    #[test]
    fn test_extreme_aspect_ratios_over_limit() {
        let result = calculate_gpu_compatible_size(100, 5000, 4096);
        assert!(result.is_some());
        assert_valid_output(result, 4096);

        let result = calculate_gpu_compatible_size(5000, 100, 4096);
        assert!(result.is_some());
        assert_valid_output(result, 4096);
    }

    #[test]
    fn test_real_world_window_sizes() {
        let window_sizes = [
            (1920, 1055),
            (2560, 1055),
            (1280, 800),
            (1440, 900),
            (1680, 1050),
            (1920, 1200),
            (2560, 1600),
            (1366, 768),
            (1536, 864),
            (1600, 900),
        ];

        for (w, h) in window_sizes {
            let result = calculate_gpu_compatible_size(w, h, 4096);
            assert_valid_output(result, 4096);
            if w % 2 == 0 && h % 2 == 0 && w <= 4096 && h <= 4096 {
                assert_eq!(
                    result, None,
                    "Even dimensions {}x{} should return None",
                    w, h
                );
            }
        }
    }

    #[test]
    fn test_mixed_odd_even_under_limit() {
        let cases = [
            (1920, 1081, 1920, 1080),
            (1919, 1080, 1918, 1080),
            (2559, 1439, 2558, 1438),
            (3839, 2159, 3838, 2158),
        ];

        for (in_w, in_h, exp_w, exp_h) in cases {
            let result = calculate_gpu_compatible_size(in_w, in_h, 4096);
            assert!(result.is_some());
            let (w, h) = result.unwrap();
            assert_eq!(
                w, exp_w,
                "Expected width {} for input {}x{}",
                exp_w, in_w, in_h
            );
            assert_eq!(
                h, exp_h,
                "Expected height {} for input {}x{}",
                exp_h, in_w, in_h
            );
        }
    }

    #[test]
    fn test_different_max_dimensions() {
        let result = calculate_gpu_compatible_size(2560, 1440, 1920);
        assert!(result.is_some());
        assert_valid_output(result, 1920);

        let result = calculate_gpu_compatible_size(1920, 1080, 1280);
        assert!(result.is_some());
        assert_valid_output(result, 1280);

        let result = calculate_gpu_compatible_size(1280, 720, 8192);
        assert_eq!(result, None);
    }

    #[test]
    fn test_all_standard_resolutions_comprehensive() {
        let standard_resolutions = [
            (640, 480),
            (800, 600),
            (1024, 768),
            (1152, 864),
            (1280, 720),
            (1280, 768),
            (1280, 800),
            (1280, 960),
            (1280, 1024),
            (1360, 768),
            (1366, 768),
            (1400, 1050),
            (1440, 900),
            (1600, 900),
            (1600, 1024),
            (1600, 1200),
            (1680, 1050),
            (1920, 1080),
            (1920, 1200),
            (2048, 1152),
            (2048, 1536),
            (2560, 1080),
            (2560, 1440),
            (2560, 1600),
            (2560, 2048),
            (3440, 1440),
            (3840, 1080),
            (3840, 1600),
            (3840, 2160),
            (4096, 2160),
            (4096, 2304),
            (5120, 1440),
            (5120, 2160),
            (5120, 2880),
            (7680, 2160),
            (7680, 4320),
        ];

        for (w, h) in standard_resolutions {
            let result = calculate_gpu_compatible_size(w, h, 4096);
            assert_valid_output(result, 4096);

            if w <= 4096 && h <= 4096 && w % 2 == 0 && h % 2 == 0 {
                assert_eq!(
                    result, None,
                    "Standard resolution {}x{} should return None",
                    w, h
                );
            } else if w > 4096 || h > 4096 {
                assert!(
                    result.is_some(),
                    "Over-limit resolution {}x{} should downscale",
                    w,
                    h
                );
            }
        }
    }

    #[test]
    fn test_downscaled_output_preserves_aspect_ratio() {
        let test_cases = [
            (5120, 2880),
            (7680, 4320),
            (5120, 2160),
            (6016, 3384),
            (5120, 1440),
        ];

        for (w, h) in test_cases {
            let result = calculate_gpu_compatible_size(w, h, 4096);
            assert!(result.is_some());
            let (out_w, out_h) = result.unwrap();
            assert_aspect_preserved(w, h, out_w, out_h, 0.03);
        }
    }
}
