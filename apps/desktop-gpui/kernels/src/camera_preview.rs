const STEPS: [f32; 10] = [
    270., 360., 480., 540., 720., 960., 1080., 1440., 1920., 2160.,
];

pub fn quantized_target((width, height): (f32, f32)) -> Option<(usize, usize)> {
    let step = |extent: f32| {
        STEPS
            .iter()
            .find(|step| extent <= **step)
            .map(|step| *step as usize)
    };
    Some((step(width)?, step(height)?))
}

pub fn cover_dimensions(source: (usize, usize), target: (usize, usize)) -> (usize, usize) {
    let (width, height) = source;
    if width == 0 || height == 0 {
        return source;
    }
    let scale = (target.0 as f64 / width as f64).max(target.1 as f64 / height as f64);
    if scale >= 1.0 {
        return source;
    }
    (
        ((width as f64 * scale).round() as usize).clamp(1, width),
        ((height as f64 * scale).round() as usize).clamp(1, height),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_round_up_to_a_fixed_step() {
        assert_eq!(quantized_target((460., 460.)), Some((480, 480)));
        assert_eq!(quantized_target((480., 480.)), Some((480, 480)));
        assert_eq!(quantized_target((481., 300.)), Some((540, 360)));
        assert_eq!(quantized_target((0., -56.)), Some((270, 270)));
        assert_eq!(quantized_target((2133.3, 1200.)), Some((2160, 1440)));
    }

    #[test]
    fn targets_beyond_the_largest_step_or_not_finite_are_uncapped() {
        assert_eq!(quantized_target((2161., 400.)), None);
        assert_eq!(quantized_target((400., f32::NAN)), None);
        assert_eq!(quantized_target((f32::INFINITY, 400.)), None);
    }

    #[test]
    fn nearby_sizes_share_a_target() {
        let targets = (461..=480)
            .map(|extent| quantized_target((extent as f32, extent as f32)))
            .collect::<Vec<_>>();
        assert!(targets.iter().all(|target| *target == Some((480, 480))));
    }

    #[test]
    fn cover_dimensions_fill_the_target_and_keep_the_source_aspect() {
        assert_eq!(cover_dimensions((1920, 1080), (480, 480)), (853, 480));
        assert_eq!(cover_dimensions((3840, 2160), (480, 480)), (853, 480));
        assert_eq!(cover_dimensions((1920, 1080), (960, 540)), (960, 540));
        assert_eq!(cover_dimensions((1440, 1080), (960, 540)), (960, 720));
        assert_eq!(cover_dimensions((1080, 1920), (480, 480)), (480, 853));
        for source in [
            (1280, 720),
            (1920, 1080),
            (3840, 2160),
            (1440, 1080),
            (1080, 1920),
        ] {
            for target in [(270, 270), (480, 480), (960, 540), (1080, 1080)] {
                let (width, height) = cover_dimensions(source, target);
                assert!(width >= target.0.min(source.0));
                assert!(height >= target.1.min(source.1));
                let aspect = source.0 as f64 / source.1 as f64;
                assert!((width as f64 / height as f64 - aspect).abs() / aspect < 0.005);
            }
        }
    }

    #[test]
    fn cover_dimensions_never_upscale() {
        assert_eq!(cover_dimensions((1280, 720), (1440, 1440)), (1280, 720));
        assert_eq!(cover_dimensions((1920, 1080), (1920, 1080)), (1920, 1080));
        assert_eq!(cover_dimensions((1920, 1080), (2160, 1080)), (1920, 1080));
        assert_eq!(cover_dimensions((0, 1080), (480, 480)), (0, 1080));
    }
}
