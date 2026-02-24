use cap_project::{MaskKind, MaskScalarKeyframe, MaskSegment, MaskVectorKeyframe, XY};

use crate::{MaskRenderMode, PreparedMask};

fn interpolate_vector(base: XY<f64>, keys: &[MaskVectorKeyframe], time: f64) -> XY<f64> {
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

fn interpolate_scalar(base: f64, keys: &[MaskScalarKeyframe], time: f64) -> f64 {
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

pub fn interpolate_masks(
    output_size: XY<u32>,
    frame_time: f64,
    segments: &[MaskSegment],
) -> Vec<PreparedMask> {
    let mut prepared = Vec::new();

    let enabled: Vec<&MaskSegment> = segments.iter().filter(|s| s.enabled).collect();

    for (i, segment) in enabled.iter().enumerate() {
        if frame_time < segment.start || frame_time > segment.end {
            continue;
        }

        let relative_time = (frame_time - segment.start).max(0.0);

        let position =
            interpolate_vector(segment.center, &segment.keyframes.position, relative_time);
        let size = interpolate_vector(segment.size, &segment.keyframes.size, relative_time);
        let mut intensity =
            interpolate_scalar(segment.opacity, &segment.keyframes.intensity, relative_time);

        let fade_duration = segment.fade_duration.max(0.0);
        if fade_duration > 0.0 {
            let adjacent_before = enabled
                .iter()
                .enumerate()
                .any(|(j, other)| i != j && (segment.start - other.end).abs() < fade_duration);

            let adjacent_after = enabled
                .iter()
                .enumerate()
                .any(|(j, other)| i != j && (other.start - segment.end).abs() < fade_duration);

            let time_since_start = (frame_time - segment.start).max(0.0);
            let time_until_end = (segment.end - frame_time).max(0.0);

            let fade_in = if adjacent_before {
                1.0
            } else {
                (time_since_start / fade_duration).min(1.0)
            };

            let fade_out = if adjacent_after {
                1.0
            } else {
                (time_until_end / fade_duration).min(1.0)
            };

            intensity *= fade_in * fade_out;
        }

        let clamped_size = XY::new(size.x.clamp(0.01, 2.0), size.y.clamp(0.01, 2.0));

        let min_axis = clamped_size.x.min(clamped_size.y).abs();
        let segment_feather = if let MaskKind::Highlight = segment.mask_type {
            0.0
        } else {
            segment.feather
        };
        let feather = (min_axis * 0.5 * segment_feather.max(0.0)).max(0.0001) as f32;

        prepared.push(PreparedMask {
            center: XY::new(
                position.x.clamp(0.0, 1.0) as f32,
                position.y.clamp(0.0, 1.0) as f32,
            ),
            size: XY::new(
                clamped_size.x.clamp(0.0, 2.0) as f32,
                clamped_size.y.clamp(0.0, 2.0) as f32,
            ),
            feather,
            opacity: intensity.clamp(0.0, 1.0) as f32,
            pixel_size: segment.pixelation.max(1.0) as f32,
            darkness: segment.darkness.clamp(0.0, 1.0) as f32,
            mode: MaskRenderMode::from_kind(segment.mask_type),
            output_size,
        });
    }

    prepared
}
