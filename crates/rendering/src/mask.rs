use cap_project::{MaskKind, MaskScalarKeyframe, MaskSegment, MaskVectorKeyframe, XY};

use crate::{MaskRenderMode, PreparedMask};

const MASK_PIXELATION_BASE_HEIGHT: f32 = 1080.0;

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

        let fade_duration = match segment.mask_type {
            MaskKind::Sensitive => 0.0,
            MaskKind::Highlight => segment.fade_duration.max(0.0),
        };
        if fade_duration > 0.0 {
            let adjacency_epsilon = 1e-3;

            let adjacent_before = enabled
                .iter()
                .enumerate()
                .any(|(j, other)| i != j && (segment.start - other.end).abs() < adjacency_epsilon);

            let adjacent_after = enabled
                .iter()
                .enumerate()
                .any(|(j, other)| i != j && (other.start - segment.end).abs() < adjacency_epsilon);

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
            pixel_size: scaled_pixel_size(output_size, segment.pixelation),
            darkness: segment.darkness.clamp(0.0, 1.0) as f32,
            mode: MaskRenderMode::from_kind(segment.mask_type),
            output_size,
        });
    }

    prepared
}

fn scaled_pixel_size(output_size: XY<u32>, pixelation: f64) -> f32 {
    let resolution_scale = output_size.y as f32 / MASK_PIXELATION_BASE_HEIGHT;
    (pixelation.max(1.0) as f32) * resolution_scale
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

    #[test]
    fn sensitive_mask_pixelation_scales_with_output_height() {
        let segment = sample_segment();
        let smaller = interpolate_masks(XY::new(872, 720), 1.0, std::slice::from_ref(&segment));
        let low = interpolate_masks(XY::new(1308, 1080), 1.0, std::slice::from_ref(&segment));
        let high = interpolate_masks(XY::new(2616, 2160), 1.0, &[segment]);

        assert_eq!(smaller.len(), 1);
        assert_eq!(low.len(), 1);
        assert_eq!(high.len(), 1);
        assert_eq!(smaller[0].pixel_size, 12.0);
        assert_eq!(low[0].pixel_size, 18.0);
        assert_eq!(high[0].pixel_size, 36.0);
    }
}
