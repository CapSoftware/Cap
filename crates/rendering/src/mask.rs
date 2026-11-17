use std::borrow::Cow;

use cap_project::{
    MaskKind, MaskScalarKeyframe, MaskSegment, MaskVectorKeyframe, XY, mask_effect_contract,
};

use crate::{MaskRenderMode, PreparedMask};

const MASK_EFFECT_BASE_HEIGHT: f32 = 1080.0;

fn sorted_by_time<T: Clone>(keys: &[T], time: impl Fn(&T) -> f64) -> Cow<'_, [T]> {
    if keys.is_sorted_by(|a, b| time(a) <= time(b)) {
        return Cow::Borrowed(keys);
    }

    let mut sorted = keys.to_vec();
    sorted.sort_by(|a, b| {
        time(a)
            .partial_cmp(&time(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Cow::Owned(sorted)
}

fn interpolate_vector(base: XY<f64>, keys: &[MaskVectorKeyframe], time: f64) -> XY<f64> {
    if keys.is_empty() {
        return base;
    }

    let sorted = sorted_by_time(keys, |key| key.time);

    if time <= sorted[0].time {
        return XY::new(sorted[0].x, sorted[0].y);
    }

    for window in sorted.windows(2) {
        let prev = &window[0];
        let next = &window[1];
        if time <= next.time {
            let span = (next.time - prev.time).max(1e-6);
            let t = ((time - prev.time) / span).clamp(0.0, 1.0);
            let x = prev.x + (next.x - prev.x) * t;
            let y = prev.y + (next.y - prev.y) * t;
            return XY::new(x, y);
        }
    }

    let last = sorted.last().unwrap();
    XY::new(last.x, last.y)
}

fn interpolate_scalar(base: f64, keys: &[MaskScalarKeyframe], time: f64) -> f64 {
    if keys.is_empty() {
        return base;
    }

    let sorted = sorted_by_time(keys, |key| key.time);

    if time <= sorted[0].time {
        return sorted[0].value;
    }

    for window in sorted.windows(2) {
        let prev = &window[0];
        let next = &window[1];
        if time <= next.time {
            let span = (next.time - prev.time).max(1e-6);
            let t = ((time - prev.time) / span).clamp(0.0, 1.0);
            return prev.value + (next.value - prev.value) * t;
        }
    }

    sorted.last().map(|k| k.value).unwrap_or(base)
}

pub fn interpolate_masks(
    output_size: XY<u32>,
    frame_time: f64,
    segments: &[MaskSegment],
) -> Vec<PreparedMask> {
    if segments.is_empty() {
        return Vec::new();
    }

    let mut prepared = Vec::new();

    let mut ordered = segments
        .iter()
        .filter(|segment| {
            segment.enabled && !(frame_time < segment.start || frame_time > segment.end)
        })
        .collect::<Vec<_>>();
    ordered.sort_by_key(|segment| segment.track);
    for segment in ordered {
        let relative_time = (frame_time - segment.start).max(0.0);

        let position =
            interpolate_vector(segment.center, &segment.keyframes.position, relative_time);
        let size = interpolate_vector(segment.size, &segment.keyframes.size, relative_time);
        let (mode, opacity, effect_amount) = match segment.mask_type {
            MaskKind::Sensitive => {
                let (mode, effect_amount) = sensitive_effect(segment.pixelation);
                (mode, 1.0, effect_amount)
            }
            MaskKind::Highlight => {
                let mut intensity = interpolate_scalar(
                    segment.opacity,
                    &segment.keyframes.intensity,
                    relative_time,
                );
                let fade_duration = segment.fade_duration.max(0.0);
                if fade_duration > 0.0 {
                    let time_since_start = (frame_time - segment.start).max(0.0);
                    let time_until_end = (segment.end - frame_time).max(0.0);
                    let fade_in = (time_since_start / fade_duration).min(1.0);
                    let fade_out = (time_until_end / fade_duration).min(1.0);
                    intensity *= fade_in * fade_out;
                }
                (MaskRenderMode::Highlight, intensity.clamp(0.0, 1.0), 0.0)
            }
        };

        let clamped_size = XY::new(size.x.clamp(0.01, 2.0), size.y.clamp(0.01, 2.0));

        let min_axis = clamped_size.x.min(clamped_size.y).abs();
        let segment_feather = if let MaskKind::Highlight = segment.mask_type {
            0.0
        } else {
            segment.feather
        };
        let feather = (min_axis * 0.5 * segment_feather.max(0.0)).max(0.0001) as f32;

        prepared.push(PreparedMask {
            track: segment.track,
            center: XY::new(
                position.x.clamp(0.0, 1.0) as f32,
                position.y.clamp(0.0, 1.0) as f32,
            ),
            size: XY::new(
                clamped_size.x.clamp(0.0, 2.0) as f32,
                clamped_size.y.clamp(0.0, 2.0) as f32,
            ),
            feather,
            opacity: opacity as f32,
            effect_size: scaled_effect_size(output_size, effect_amount),
            darkness: segment.darkness.clamp(0.0, 1.0) as f32,
            mode,
            output_size,
        });
    }

    prepared
}

fn sensitive_effect(stored_effect: f64) -> (MaskRenderMode, f64) {
    let contract = mask_effect_contract();
    let stored_effect = if stored_effect.is_finite() {
        stored_effect
    } else {
        contract.default_amount
    };
    if stored_effect >= contract.blur_encoding_offset {
        (
            MaskRenderMode::Blur,
            normalize_effect_amount(stored_effect - contract.blur_encoding_offset),
        )
    } else {
        (
            MaskRenderMode::Pixelate,
            normalize_effect_amount(stored_effect),
        )
    }
}

fn normalize_effect_amount(amount: f64) -> f64 {
    let contract = mask_effect_contract();
    if amount <= 0.0 {
        contract.default_amount
    } else {
        amount.clamp(contract.min_amount, contract.max_amount)
    }
}

fn scaled_effect_size(output_size: XY<u32>, amount: f64) -> f32 {
    let resolution_scale = output_size.y as f32 / MASK_EFFECT_BASE_HEIGHT;
    amount as f32 * resolution_scale
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_segment() -> MaskSegment {
        MaskSegment {
            start: 0.0,
            end: 10.0,
            track: 0,
            enabled: true,
            mask_type: MaskKind::Sensitive,
            center: XY::new(0.5, 0.5),
            size: XY::new(0.25, 0.25),
            feather: 0.1,
            opacity: 1.0,
            pixelation: 18.0,
            darkness: 0.5,
            fade_duration: 0.0,
            keyframes: Default::default(),
        }
    }

    fn old_interpolate_vector(base: XY<f64>, keys: &[MaskVectorKeyframe], time: f64) -> XY<f64> {
        if keys.is_empty() {
            return base;
        }

        let mut sorted = keys.to_vec();
        sorted.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        if time <= sorted[0].time {
            return XY::new(sorted[0].x, sorted[0].y);
        }

        for window in sorted.windows(2) {
            let prev = &window[0];
            let next = &window[1];
            if time <= next.time {
                let span = (next.time - prev.time).max(1e-6);
                let t = ((time - prev.time) / span).clamp(0.0, 1.0);
                let x = prev.x + (next.x - prev.x) * t;
                let y = prev.y + (next.y - prev.y) * t;
                return XY::new(x, y);
            }
        }

        let last = sorted.last().unwrap();
        XY::new(last.x, last.y)
    }

    fn old_interpolate_scalar(base: f64, keys: &[MaskScalarKeyframe], time: f64) -> f64 {
        if keys.is_empty() {
            return base;
        }

        let mut sorted = keys.to_vec();
        sorted.sort_by(|a, b| {
            a.time
                .partial_cmp(&b.time)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        if time <= sorted[0].time {
            return sorted[0].value;
        }

        for window in sorted.windows(2) {
            let prev = &window[0];
            let next = &window[1];
            if time <= next.time {
                let span = (next.time - prev.time).max(1e-6);
                let t = ((time - prev.time) / span).clamp(0.0, 1.0);
                return prev.value + (next.value - prev.value) * t;
            }
        }

        sorted.last().map(|k| k.value).unwrap_or(base)
    }

    fn vector_key(time: f64, x: f64, y: f64) -> MaskVectorKeyframe {
        MaskVectorKeyframe { time, x, y }
    }

    fn scalar_key(time: f64, value: f64) -> MaskScalarKeyframe {
        MaskScalarKeyframe { time, value }
    }

    const QUERY_TIMES: [f64; 13] = [
        f64::NEG_INFINITY,
        -1.0,
        0.0,
        0.25,
        0.5,
        1.0,
        1.5,
        2.0,
        2.5,
        3.0,
        f64::INFINITY,
        f64::NAN,
        -0.0,
    ];

    #[test]
    fn keyframe_order_does_not_change_interpolation() {
        let sorted = vec![
            vector_key(0.0, 0.1, 0.2),
            vector_key(1.0, 0.4, 0.3),
            vector_key(1.0, 0.6, 0.1),
            vector_key(2.5, 0.9, 0.8),
        ];
        let mut unsorted = sorted.clone();
        unsorted.swap(0, 3);
        unsorted.swap(1, 3);
        let vector_cases = [
            sorted.clone(),
            unsorted,
            vec![],
            vec![vector_key(1.0, 0.3, 0.7)],
            vec![
                vector_key(2.0, 0.9, 0.9),
                vector_key(f64::NAN, 0.5, 0.5),
                vector_key(0.0, 0.1, 0.1),
            ],
            vec![
                vector_key(0.0, 0.1, 0.1),
                vector_key(f64::NAN, 0.5, 0.5),
                vector_key(2.0, 0.9, 0.9),
            ],
            vec![
                vector_key(f64::NEG_INFINITY, 0.2, 0.2),
                vector_key(f64::INFINITY, 0.8, 0.8),
            ],
        ];

        let scalar_sorted = vec![
            scalar_key(0.5, 0.2),
            scalar_key(1.0, 0.4),
            scalar_key(1.0, 0.7),
            scalar_key(2.0, 0.9),
        ];
        let scalar_cases = [
            scalar_sorted.iter().rev().cloned().collect::<Vec<_>>(),
            scalar_sorted,
            vec![],
            vec![scalar_key(1.0, 0.6)],
            vec![
                scalar_key(1.0, 0.6),
                scalar_key(f64::NAN, 0.1),
                scalar_key(0.0, 0.3),
            ],
            vec![
                scalar_key(0.0, 0.3),
                scalar_key(f64::NAN, 0.1),
                scalar_key(1.0, 0.6),
            ],
        ];

        let base = XY::new(0.5, 0.5);
        for time in QUERY_TIMES {
            for keys in &vector_cases {
                let expected = old_interpolate_vector(base, keys, time);
                let actual = interpolate_vector(base, keys, time);
                assert_eq!(
                    (actual.x.to_bits(), actual.y.to_bits()),
                    (expected.x.to_bits(), expected.y.to_bits()),
                    "time {time} keys {keys:?}"
                );
            }
            for keys in &scalar_cases {
                assert_eq!(
                    interpolate_scalar(0.3, keys, time).to_bits(),
                    old_interpolate_scalar(0.3, keys, time).to_bits(),
                    "time {time} keys {keys:?}"
                );
            }
        }
    }

    #[test]
    fn only_out_of_order_or_non_finite_keyframes_are_cloned() {
        let time = |key: &MaskVectorKeyframe| key.time;
        let in_order = [
            vector_key(0.0, 0.0, 0.0),
            vector_key(1.0, 1.0, 1.0),
            vector_key(1.0, 0.5, 0.5),
            vector_key(2.0, 0.2, 0.2),
        ];
        assert!(matches!(sorted_by_time(&in_order, time), Cow::Borrowed(_)));
        assert!(matches!(
            sorted_by_time(&in_order[..1], time),
            Cow::Borrowed(_)
        ));
        assert!(matches!(sorted_by_time(&[], time), Cow::Borrowed(_)));

        let out_of_order = [vector_key(1.0, 0.0, 0.0), vector_key(0.0, 1.0, 1.0)];
        assert!(matches!(sorted_by_time(&out_of_order, time), Cow::Owned(_)));

        let with_nan = [
            vector_key(0.0, 0.0, 0.0),
            vector_key(f64::NAN, 0.5, 0.5),
            vector_key(2.0, 1.0, 1.0),
        ];
        assert!(matches!(sorted_by_time(&with_nan, time), Cow::Owned(_)));
    }

    #[test]
    fn mask_layers_follow_lane_order_with_stable_ties() {
        let mut front = sample_segment();
        front.track = 2;
        front.center.x = 0.75;
        let mut back = front.clone();
        back.track = 0;
        back.center.x = 0.25;
        let mut later_front = front.clone();
        later_front.center.x = 0.5;
        let masks = interpolate_masks(XY::new(1920, 1080), 1.0, &[front, back, later_front]);
        assert_eq!(masks.len(), 3);
        assert_eq!(
            masks.iter().map(|mask| mask.track).collect::<Vec<_>>(),
            [0, 2, 2]
        );
        assert!(masks[0].center.x < masks[2].center.x);
        assert!(masks[2].center.x < masks[1].center.x);
    }

    #[test]
    fn active_masks_preserve_order_and_include_time_boundaries() {
        let mut first = sample_segment();
        first.track = 2;
        first.center.x = 0.25;
        let mut inactive = first.clone();
        inactive.start = 20.0;
        inactive.end = 30.0;
        inactive.track = 0;
        let mut last = first.clone();
        last.center.x = 0.75;
        let mut disabled = first.clone();
        disabled.enabled = false;
        disabled.track = 0;
        let segments = [first, inactive, last, disabled];

        for time in [0.0, 5.0, 10.0] {
            let masks = interpolate_masks(XY::new(1920, 1080), time, &segments);
            assert_eq!(masks.len(), 2);
            assert_eq!(masks[0].center.x, 0.25);
            assert_eq!(masks[1].center.x, 0.75);
        }
        for time in [-1.0, 15.0, 31.0] {
            assert!(interpolate_masks(XY::new(1920, 1080), time, &segments).is_empty());
        }
    }

    #[test]
    fn mask_time_filter_preserves_nonfinite_comparison_behavior() {
        let mut segment = sample_segment();
        segment.start = f64::NAN;
        let masks = interpolate_masks(XY::new(1920, 1080), 5.0, std::slice::from_ref(&segment));
        assert_eq!(masks.len(), 1);
        assert!(interpolate_masks(XY::new(1920, 1080), 11.0, &[segment]).is_empty());

        let mut disabled = sample_segment();
        disabled.enabled = false;
        let segments = [sample_segment(), disabled];
        assert_eq!(
            interpolate_masks(XY::new(1920, 1080), f64::NAN, &segments).len(),
            1
        );
        for time in [f64::NEG_INFINITY, f64::INFINITY] {
            assert!(interpolate_masks(XY::new(1920, 1080), time, &segments).is_empty());
        }
    }

    #[test]
    fn sensitive_mask_effect_scales_with_output_height() {
        let segment = sample_segment();
        let smaller = interpolate_masks(XY::new(872, 720), 1.0, std::slice::from_ref(&segment));
        let low = interpolate_masks(XY::new(1308, 1080), 1.0, std::slice::from_ref(&segment));
        let high = interpolate_masks(XY::new(2616, 2160), 1.0, &[segment]);

        assert_eq!(smaller.len(), 1);
        assert_eq!(low.len(), 1);
        assert_eq!(high.len(), 1);
        assert_eq!(smaller[0].effect_size, 12.0);
        assert_eq!(low[0].effect_size, 18.0);
        assert_eq!(high[0].effect_size, 36.0);
    }

    #[test]
    fn sensitive_mask_never_blends_with_source_content() {
        let mut segment = sample_segment();
        segment.opacity = 0.01;
        segment.keyframes.intensity.push(MaskScalarKeyframe {
            time: 1.0,
            value: 0.01,
        });

        let masks = interpolate_masks(XY::new(1920, 1080), 1.0, &[segment]);

        assert_eq!(masks[0].opacity, 1.0);
        assert_eq!(masks[0].mode, MaskRenderMode::Pixelate);
    }

    #[test]
    fn persisted_effect_encoding_matches_the_desktop_contract() {
        for (stored_effect, expected_mode, expected_size) in [
            (18.0, MaskRenderMode::Pixelate, 18.0),
            (1001.0, MaskRenderMode::Blur, 4.0),
            (1024.0, MaskRenderMode::Blur, 24.0),
            (1080.0, MaskRenderMode::Blur, 80.0),
        ] {
            let mut segment = sample_segment();
            segment.pixelation = stored_effect;

            let masks = interpolate_masks(XY::new(1920, 1080), 1.0, &[segment]);

            assert_eq!(masks[0].mode, expected_mode);
            assert_eq!(masks[0].effect_size, expected_size);
            assert_eq!(masks[0].opacity, 1.0);
        }
    }

    #[test]
    fn missing_legacy_pixelation_uses_a_visible_safe_default() {
        let mut segment = sample_segment();
        segment.pixelation = 0.0;

        let masks = interpolate_masks(XY::new(1920, 1080), 1.0, &[segment]);

        assert_eq!(masks[0].mode, MaskRenderMode::Pixelate);
        assert_eq!(masks[0].effect_size, 16.0);
    }
}
