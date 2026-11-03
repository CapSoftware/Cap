/// Largest FFmpeg MJPEG `lowres` whose decoded frame still covers
/// `target_width`×`target_height`.
///
/// `0` is full resolution, `1` is 1/2, `2` is 1/4, `3` is 1/8. Dimensions use
/// the decoder's ceiling division, so the choice cannot undershoot the frame
/// FFmpeg actually returns.
pub(crate) fn idct_lowres(
    source_width: u32,
    source_height: u32,
    target_width: u32,
    target_height: u32,
) -> i32 {
    if source_width == 0 || source_height == 0 || target_width == 0 || target_height == 0 {
        return 0;
    }
    let mut lowres = 0;
    for candidate in 1..=3 {
        let (width, height) = scaled_dimensions(source_width, source_height, candidate);
        if width < target_width || height < target_height || width == 0 || height == 0 {
            break;
        }
        lowres = candidate;
    }
    lowres
}

pub(crate) fn scaled_dimensions(source_width: u32, source_height: u32, lowres: i32) -> (u32, u32) {
    if lowres <= 0 {
        return (source_width, source_height);
    }
    let shift = u32::try_from(lowres).unwrap_or(3).min(3);
    let divisor = 1u32 << shift;
    (
        source_width.saturating_add(divisor - 1) / divisor,
        source_height.saturating_add(divisor - 1) / divisor,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bubble_on_1080p_uses_half_idct() {
        assert_eq!(idct_lowres(1920, 1080, 324, 324), 1);
        assert_eq!(scaled_dimensions(1920, 1080, 1), (960, 540));
    }

    #[test]
    fn smaller_bubble_uses_quarter_idct() {
        assert_eq!(idct_lowres(1920, 1080, 216, 216), 2);
        assert_eq!(scaled_dimensions(1920, 1080, 2), (480, 270));
        assert_eq!(scaled_dimensions(1920, 1080, 3), (240, 135));
    }

    #[test]
    fn studio_and_large_overlay_stay_full_resolution() {
        assert_eq!(idct_lowres(1920, 1080, 1920, 1080), 0);
        assert_eq!(idct_lowres(1920, 1080, 648, 648), 0);
        assert_eq!(idct_lowres(1280, 720, 432, 432), 0);
        assert_eq!(idct_lowres(1920, 1080, 0, 324), 0);
    }

    #[test]
    fn ceiling_division_matches_odd_mjpeg_lowres() {
        assert_eq!(scaled_dimensions(1919, 1079, 1), (960, 540));
        assert_eq!(scaled_dimensions(641, 481, 1), (321, 241));
        assert_eq!(idct_lowres(1919, 1079, 960, 540), 1);
    }
}
