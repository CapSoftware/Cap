use cap_project::{Layout3DEasing, Layout3DSegment};

#[derive(Debug, Clone, Copy)]
pub struct Layout3DSegmentsCursor<'a> {
    time: f64,
    segment: Option<&'a Layout3DSegment>,
    prev_segment: Option<&'a Layout3DSegment>,
}

impl<'a> Layout3DSegmentsCursor<'a> {
    pub fn new(time: f64, segments: &'a [Layout3DSegment]) -> Self {
        match segments
            .iter()
            .position(|s| s.enabled && time > s.start && time <= s.end)
        {
            Some(segment_index) => Layout3DSegmentsCursor {
                time,
                segment: Some(&segments[segment_index]),
                prev_segment: segments[..segment_index]
                    .iter()
                    .rev()
                    .find(|s| s.enabled && s.end <= segments[segment_index].start),
            },
            None => {
                let prev = segments.iter().rev().find(|s| s.enabled && s.end <= time);
                Layout3DSegmentsCursor {
                    time,
                    segment: None,
                    prev_segment: prev,
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct InterpolatedLayout3D {
    pub rotation_x: f64,
    pub rotation_y: f64,
    pub depth_zoom: f64,
    pub t: f64,
}

impl Default for InterpolatedLayout3D {
    fn default() -> Self {
        Self {
            rotation_x: 0.0,
            rotation_y: 0.0,
            depth_zoom: 1.0,
            t: 0.0,
        }
    }
}

impl InterpolatedLayout3D {
    pub fn new(cursor: Layout3DSegmentsCursor) -> Self {
        match (cursor.prev_segment, cursor.segment) {
            (Some(prev), None) => {
                let fade_duration = prev.fade_duration.max(0.01);
                let elapsed = cursor.time - prev.end;
                let raw_t = (elapsed / fade_duration).clamp(0.0, 1.0);
                let t = apply_easing(raw_t, prev.easing);

                let progress = compute_segment_progress(prev.end, prev, prev.easing);

                Self {
                    rotation_x: prev.rotation_x * progress * (1.0 - t),
                    rotation_y: prev.rotation_y * progress * (1.0 - t),
                    depth_zoom: 1.0 + (prev.depth_zoom - 1.0) * progress * (1.0 - t),
                    t: 1.0 - t,
                }
            }
            (None, Some(seg)) => {
                let fade_duration = seg.fade_duration.max(0.01);
                let elapsed = cursor.time - seg.start;
                let raw_t = (elapsed / fade_duration).clamp(0.0, 1.0);
                let t = apply_easing(raw_t, seg.easing);

                let progress = compute_segment_progress(cursor.time, seg, seg.easing);

                Self {
                    rotation_x: seg.rotation_x * progress * t,
                    rotation_y: seg.rotation_y * progress * t,
                    depth_zoom: 1.0 + (seg.depth_zoom - 1.0) * progress * t,
                    t,
                }
            }
            (Some(prev), Some(seg)) => {
                let fade_duration = seg.fade_duration.max(0.01);
                let elapsed = cursor.time - seg.start;
                let raw_t = (elapsed / fade_duration).clamp(0.0, 1.0);
                let t = apply_easing(raw_t, seg.easing);

                let prev_progress = compute_segment_progress(prev.end, prev, prev.easing);
                let curr_progress = compute_segment_progress(cursor.time, seg, seg.easing);

                let prev_rot_x = prev.rotation_x * prev_progress;
                let prev_rot_y = prev.rotation_y * prev_progress;
                let prev_zoom = 1.0 + (prev.depth_zoom - 1.0) * prev_progress;

                let curr_rot_x = seg.rotation_x * curr_progress;
                let curr_rot_y = seg.rotation_y * curr_progress;
                let curr_zoom = 1.0 + (seg.depth_zoom - 1.0) * curr_progress;

                Self {
                    rotation_x: prev_rot_x * (1.0 - t) + curr_rot_x * t,
                    rotation_y: prev_rot_y * (1.0 - t) + curr_rot_y * t,
                    depth_zoom: prev_zoom * (1.0 - t) + curr_zoom * t,
                    t: 1.0,
                }
            }
            (None, None) => Self::default(),
        }
    }

    pub fn is_identity(&self) -> bool {
        self.t < 0.001
            && self.rotation_x.abs() < 0.001
            && self.rotation_y.abs() < 0.001
            && (self.depth_zoom - 1.0).abs() < 0.001
    }

    pub fn to_matrix(&self) -> [[f32; 4]; 4] {
        if self.is_identity() {
            return identity_matrix();
        }

        let rx = (self.rotation_x as f32).to_radians();
        let ry = (self.rotation_y as f32).to_radians();
        let zoom = self.depth_zoom as f32;

        let cos_rx = rx.cos();
        let sin_rx = rx.sin();
        let cos_ry = ry.cos();
        let sin_ry = ry.sin();

        let rot_x = [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, cos_rx, -sin_rx, 0.0],
            [0.0, sin_rx, cos_rx, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ];

        let rot_y = [
            [cos_ry, 0.0, sin_ry, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [-sin_ry, 0.0, cos_ry, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ];

        let scale = [
            [zoom, 0.0, 0.0, 0.0],
            [0.0, zoom, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ];

        let perspective_strength = 0.001;
        let perspective = [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, perspective_strength],
            [0.0, 0.0, 0.0, 1.0],
        ];

        let rot = mat4_mul(rot_y, rot_x);
        let transform = mat4_mul(scale, rot);
        mat4_mul(perspective, transform)
    }

    pub fn transform_position(&self, position: [f32; 2], screen_bounds: [f32; 4]) -> [f32; 2] {
        if self.is_identity() {
            return position;
        }

        let matrix = self.to_matrix();
        let screen_min = [screen_bounds[0], screen_bounds[1]];
        let screen_size = [
            screen_bounds[2] - screen_bounds[0],
            screen_bounds[3] - screen_bounds[1],
        ];

        if screen_size[0] < 1.0 || screen_size[1] < 1.0 {
            return position;
        }

        let uv = [
            (position[0] - screen_min[0]) / screen_size[0],
            (position[1] - screen_min[1]) / screen_size[1],
        ];

        let centered = [(uv[0] - 0.5) * 2.0, (uv[1] - 0.5) * 2.0];

        let point = [centered[0], centered[1], 0.0, 1.0];
        let transformed = [
            matrix[0][0] * point[0]
                + matrix[0][1] * point[1]
                + matrix[0][2] * point[2]
                + matrix[0][3] * point[3],
            matrix[1][0] * point[0]
                + matrix[1][1] * point[1]
                + matrix[1][2] * point[2]
                + matrix[1][3] * point[3],
            matrix[2][0] * point[0]
                + matrix[2][1] * point[1]
                + matrix[2][2] * point[2]
                + matrix[2][3] * point[3],
            matrix[3][0] * point[0]
                + matrix[3][1] * point[1]
                + matrix[3][2] * point[2]
                + matrix[3][3] * point[3],
        ];

        let w = transformed[3].max(0.001);
        let projected = [transformed[0] / w, transformed[1] / w];

        let new_uv = [projected[0] * 0.5 + 0.5, projected[1] * 0.5 + 0.5];

        [
            new_uv[0] * screen_size[0] + screen_min[0],
            new_uv[1] * screen_size[1] + screen_min[1],
        ]
    }
}

fn compute_segment_progress(time: f64, segment: &Layout3DSegment, easing: Layout3DEasing) -> f64 {
    let duration = segment.end - segment.start;
    if duration <= 0.0 {
        return 1.0;
    }
    let elapsed = (time - segment.start).clamp(0.0, duration);
    let raw_progress = elapsed / duration;
    apply_easing(raw_progress, easing)
}

fn apply_easing(t: f64, easing: Layout3DEasing) -> f64 {
    match easing {
        Layout3DEasing::Linear => t,
        Layout3DEasing::EaseIn => t * t,
        Layout3DEasing::EaseOut => 1.0 - (1.0 - t) * (1.0 - t),
        Layout3DEasing::EaseInOut => {
            if t < 0.5 {
                2.0 * t * t
            } else {
                1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
            }
        }
    }
}

fn identity_matrix() -> [[f32; 4]; 4] {
    [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

fn mat4_mul(a: [[f32; 4]; 4], b: [[f32; 4]; 4]) -> [[f32; 4]; 4] {
    let mut result = [[0.0f32; 4]; 4];
    for i in 0..4 {
        for j in 0..4 {
            result[i][j] =
                a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j] + a[i][3] * b[3][j];
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_segment(start: f64, end: f64, rx: f64, ry: f64, zoom: f64) -> Layout3DSegment {
        Layout3DSegment {
            start,
            end,
            enabled: true,
            rotation_x: rx,
            rotation_y: ry,
            depth_zoom: zoom,
            easing: Layout3DEasing::Linear,
            fade_duration: 0.5,
        }
    }

    #[test]
    fn no_segments_returns_identity() {
        let cursor = Layout3DSegmentsCursor::new(1.0, &[]);
        let interp = InterpolatedLayout3D::new(cursor);
        assert!(interp.is_identity());
    }

    #[test]
    fn inside_segment_interpolates() {
        let segments = vec![make_segment(0.0, 10.0, 10.0, -15.0, 1.2)];
        let cursor = Layout3DSegmentsCursor::new(5.5, &segments);
        let interp = InterpolatedLayout3D::new(cursor);
        assert!(interp.rotation_x > 0.0);
        assert!(interp.rotation_y < 0.0);
        assert!(interp.depth_zoom > 1.0);
    }

    #[test]
    fn after_segment_fades_out() {
        let segments = vec![make_segment(0.0, 2.0, 10.0, -15.0, 1.2)];
        let cursor = Layout3DSegmentsCursor::new(2.5, &segments);
        let interp = InterpolatedLayout3D::new(cursor);
        assert!(interp.rotation_x < 10.0);
        assert!(interp.t < 1.0);
    }

    #[test]
    fn matrix_identity_when_no_transform() {
        let interp = InterpolatedLayout3D::default();
        let matrix = interp.to_matrix();
        assert_eq!(matrix[0][0], 1.0);
        assert_eq!(matrix[1][1], 1.0);
        assert_eq!(matrix[2][2], 1.0);
        assert_eq!(matrix[3][3], 1.0);
    }
}
