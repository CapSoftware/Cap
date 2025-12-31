pub const H264_MAX_DIMENSION: u32 = 4096;

pub fn calculate_gpu_compatible_size(
    width: u32,
    height: u32,
    max_dimension: u32,
) -> Option<(u32, u32)> {
    if width <= max_dimension && height <= max_dimension {
        return None;
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

    #[test]
    fn test_below_limits_returns_none() {
        assert_eq!(calculate_gpu_compatible_size(3840, 2160, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(1920, 1080, 4096), None);
    }

    #[test]
    fn test_exactly_at_limit_returns_none() {
        assert_eq!(calculate_gpu_compatible_size(4096, 4096, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(4096, 2160, 4096), None);
        assert_eq!(calculate_gpu_compatible_size(3840, 4096, 4096), None);
    }

    #[test]
    fn test_5k_landscape_downscales() {
        let result = calculate_gpu_compatible_size(5120, 2880, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert!(w <= 4096);
        assert!(h <= 4096);
        assert_eq!(w % 2, 0);
        assert_eq!(h % 2, 0);
        let original_aspect = 5120.0 / 2880.0;
        let result_aspect = w as f64 / h as f64;
        assert!((original_aspect - result_aspect).abs() < 0.02);
    }

    #[test]
    fn test_5k_ultrawide_downscales() {
        let result = calculate_gpu_compatible_size(5120, 2160, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert!(w <= 4096);
        assert!(h <= 4096);
        assert_eq!(w % 2, 0);
        assert_eq!(h % 2, 0);
    }

    #[test]
    fn test_portrait_mode_downscales() {
        let result = calculate_gpu_compatible_size(2880, 5120, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert!(w <= 4096);
        assert!(h <= 4096);
        assert_eq!(w % 2, 0);
        assert_eq!(h % 2, 0);
    }

    #[test]
    fn test_extreme_resolution() {
        let result = calculate_gpu_compatible_size(7680, 4320, 4096);
        assert!(result.is_some());
        let (w, h) = result.unwrap();
        assert!(w <= 4096);
        assert!(h <= 4096);
        assert_eq!(w % 2, 0);
        assert_eq!(h % 2, 0);
    }

    #[test]
    fn test_ensure_even() {
        assert_eq!(ensure_even(100), 100);
        assert_eq!(ensure_even(101), 100);
        assert_eq!(ensure_even(1), 2);
        assert_eq!(ensure_even(0), 2);
    }
}
