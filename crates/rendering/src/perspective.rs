use cap_project::{PerspectiveAnimation, PerspectiveSegment};

pub const PERSPECTIVE_TRANSITION_DURATION: f64 = 0.4;

#[derive(Debug, Clone, Copy)]
pub struct Mat4([[f32; 4]; 4]);

impl Mat4 {
    pub fn identity() -> Self {
        Self([
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ])
    }

    pub fn rotation_x(angle_deg: f32) -> Self {
        let r = angle_deg.to_radians();
        let c = r.cos();
        let s = r.sin();
        Self([
            [1.0, 0.0, 0.0, 0.0],
            [0.0, c, -s, 0.0],
            [0.0, s, c, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ])
    }

    pub fn rotation_y(angle_deg: f32) -> Self {
        let r = angle_deg.to_radians();
        let c = r.cos();
        let s = r.sin();
        Self([
            [c, 0.0, s, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [-s, 0.0, c, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ])
    }

    pub fn rotation_z(angle_deg: f32) -> Self {
        let r = angle_deg.to_radians();
        let c = r.cos();
        let s = r.sin();
        Self([
            [c, -s, 0.0, 0.0],
            [s, c, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ])
    }

    pub fn translation(x: f32, y: f32, z: f32) -> Self {
        Self([
            [1.0, 0.0, 0.0, x],
            [0.0, 1.0, 0.0, y],
            [0.0, 0.0, 1.0, z],
            [0.0, 0.0, 0.0, 1.0],
        ])
    }

    pub fn perspective(fov_deg: f32, aspect: f32, near: f32, far: f32) -> Self {
        let f = 1.0 / (fov_deg.to_radians() * 0.5).tan();
        let range_inv = 1.0 / (near - far);
        Self([
            [f / aspect, 0.0, 0.0, 0.0],
            [0.0, f, 0.0, 0.0],
            [
                0.0,
                0.0,
                (far + near) * range_inv,
                2.0 * far * near * range_inv,
            ],
            [0.0, 0.0, -1.0, 0.0],
        ])
    }

    pub fn mul(&self, other: &Mat4) -> Mat4 {
        let a = &self.0;
        let b = &other.0;
        let mut result = [[0.0f32; 4]; 4];
        for i in 0..4 {
            for j in 0..4 {
                result[i][j] =
                    a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j] + a[i][3] * b[3][j];
            }
        }
        Mat4(result)
    }

    pub fn inverse(&self) -> Mat4 {
        let m = &self.0;
        let mut inv = [0.0f32; 16];
        let flat: Vec<f32> = m.iter().flat_map(|row| row.iter().copied()).collect();

        inv[0] = flat[5] * flat[10] * flat[15]
            - flat[5] * flat[11] * flat[14]
            - flat[9] * flat[6] * flat[15]
            + flat[9] * flat[7] * flat[14]
            + flat[13] * flat[6] * flat[11]
            - flat[13] * flat[7] * flat[10];

        inv[4] = -flat[4] * flat[10] * flat[15]
            + flat[4] * flat[11] * flat[14]
            + flat[8] * flat[6] * flat[15]
            - flat[8] * flat[7] * flat[14]
            - flat[12] * flat[6] * flat[11]
            + flat[12] * flat[7] * flat[10];

        inv[8] = flat[4] * flat[9] * flat[15]
            - flat[4] * flat[11] * flat[13]
            - flat[8] * flat[5] * flat[15]
            + flat[8] * flat[7] * flat[13]
            + flat[12] * flat[5] * flat[11]
            - flat[12] * flat[7] * flat[9];

        inv[12] = -flat[4] * flat[9] * flat[14]
            + flat[4] * flat[10] * flat[13]
            + flat[8] * flat[5] * flat[14]
            - flat[8] * flat[6] * flat[13]
            - flat[12] * flat[5] * flat[10]
            + flat[12] * flat[6] * flat[9];

        inv[1] = -flat[1] * flat[10] * flat[15]
            + flat[1] * flat[11] * flat[14]
            + flat[9] * flat[2] * flat[15]
            - flat[9] * flat[3] * flat[14]
            - flat[13] * flat[2] * flat[11]
            + flat[13] * flat[3] * flat[10];

        inv[5] = flat[0] * flat[10] * flat[15]
            - flat[0] * flat[11] * flat[14]
            - flat[8] * flat[2] * flat[15]
            + flat[8] * flat[3] * flat[14]
            + flat[12] * flat[2] * flat[11]
            - flat[12] * flat[3] * flat[10];

        inv[9] = -flat[0] * flat[9] * flat[15]
            + flat[0] * flat[11] * flat[13]
            + flat[8] * flat[1] * flat[15]
            - flat[8] * flat[3] * flat[13]
            - flat[12] * flat[1] * flat[11]
            + flat[12] * flat[3] * flat[9];

        inv[13] = flat[0] * flat[9] * flat[14]
            - flat[0] * flat[10] * flat[13]
            - flat[8] * flat[1] * flat[14]
            + flat[8] * flat[2] * flat[13]
            + flat[12] * flat[1] * flat[10]
            - flat[12] * flat[2] * flat[9];

        inv[2] = flat[1] * flat[6] * flat[15]
            - flat[1] * flat[7] * flat[14]
            - flat[5] * flat[2] * flat[15]
            + flat[5] * flat[3] * flat[14]
            + flat[13] * flat[2] * flat[7]
            - flat[13] * flat[3] * flat[6];

        inv[6] = -flat[0] * flat[6] * flat[15]
            + flat[0] * flat[7] * flat[14]
            + flat[4] * flat[2] * flat[15]
            - flat[4] * flat[3] * flat[14]
            - flat[12] * flat[2] * flat[7]
            + flat[12] * flat[3] * flat[6];

        inv[10] = flat[0] * flat[5] * flat[15]
            - flat[0] * flat[7] * flat[13]
            - flat[4] * flat[1] * flat[15]
            + flat[4] * flat[3] * flat[13]
            + flat[12] * flat[1] * flat[7]
            - flat[12] * flat[3] * flat[5];

        inv[14] = -flat[0] * flat[5] * flat[14]
            + flat[0] * flat[6] * flat[13]
            + flat[4] * flat[1] * flat[14]
            - flat[4] * flat[2] * flat[13]
            - flat[12] * flat[1] * flat[6]
            + flat[12] * flat[2] * flat[5];

        inv[3] = -flat[1] * flat[6] * flat[11]
            + flat[1] * flat[7] * flat[10]
            + flat[5] * flat[2] * flat[11]
            - flat[5] * flat[3] * flat[10]
            - flat[9] * flat[2] * flat[7]
            + flat[9] * flat[3] * flat[6];

        inv[7] = flat[0] * flat[6] * flat[11]
            - flat[0] * flat[7] * flat[10]
            - flat[4] * flat[2] * flat[11]
            + flat[4] * flat[3] * flat[10]
            + flat[8] * flat[2] * flat[7]
            - flat[8] * flat[3] * flat[6];

        inv[11] = -flat[0] * flat[5] * flat[11]
            + flat[0] * flat[7] * flat[9]
            + flat[4] * flat[1] * flat[11]
            - flat[4] * flat[3] * flat[9]
            - flat[8] * flat[1] * flat[7]
            + flat[8] * flat[3] * flat[5];

        inv[15] = flat[0] * flat[5] * flat[10]
            - flat[0] * flat[6] * flat[9]
            - flat[4] * flat[1] * flat[10]
            + flat[4] * flat[2] * flat[9]
            + flat[8] * flat[1] * flat[6]
            - flat[8] * flat[2] * flat[5];

        let det = flat[0] * inv[0] + flat[1] * inv[4] + flat[2] * inv[8] + flat[3] * inv[12];

        if det.abs() < 1e-10 {
            return Mat4::identity();
        }

        let inv_det = 1.0 / det;
        let mut result = [[0.0f32; 4]; 4];
        for i in 0..4 {
            for j in 0..4 {
                result[i][j] = inv[i * 4 + j] * inv_det;
            }
        }
        Mat4(result)
    }

    pub fn to_column_major(&self) -> [[f32; 4]; 4] {
        let m = &self.0;
        [
            [m[0][0], m[1][0], m[2][0], m[3][0]],
            [m[0][1], m[1][1], m[2][1], m[3][1]],
            [m[0][2], m[1][2], m[2][2], m[3][2]],
            [m[0][3], m[1][3], m[2][3], m[3][3]],
        ]
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PerspectiveSegmentsCursor<'a> {
    time: f64,
    segment: Option<&'a PerspectiveSegment>,
    segments: &'a [PerspectiveSegment],
}

impl<'a> PerspectiveSegmentsCursor<'a> {
    pub fn new(time: f64, segments: &'a [PerspectiveSegment]) -> Self {
        let segment = segments.iter().find(|s| time >= s.start && time < s.end);
        PerspectiveSegmentsCursor {
            time,
            segment,
            segments,
        }
    }

    pub fn next_segment(&self) -> Option<&'a PerspectiveSegment> {
        let current_time = self.time;
        self.segments.iter().find(|s| s.start > current_time)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PerspectiveParams {
    pub rotation_x: f64,
    pub rotation_y: f64,
    pub rotation_z: f64,
    pub fov: f64,
    pub camera_distance: f64,
    pub zoom: f64,
}

impl Default for PerspectiveParams {
    fn default() -> Self {
        Self {
            rotation_x: 0.0,
            rotation_y: 0.0,
            rotation_z: 0.0,
            fov: 80.0,
            camera_distance: 40.0,
            zoom: 1.0,
        }
    }
}

impl PerspectiveParams {
    fn from_segment(segment: &PerspectiveSegment, time: f64) -> Self {
        let mut distance = segment.camera_distance;
        let mut zoom = segment.zoom;

        let duration = segment.end - segment.start;
        if duration > 0.0 {
            let t = ((time - segment.start) / duration).clamp(0.0, 1.0);
            let eased_t = ease_in_out(t);

            match segment.animation {
                PerspectiveAnimation::None => {}
                PerspectiveAnimation::ZoomIn => {
                    distance *= 1.0 + 0.3 * (1.0 - eased_t);
                    zoom *= 0.85 + 0.15 * eased_t;
                }
                PerspectiveAnimation::ZoomOut => {
                    distance *= 1.0 + 0.3 * eased_t;
                    zoom *= 1.0 - 0.15 * eased_t;
                }
            }
        }

        Self {
            rotation_x: segment.rotation_x,
            rotation_y: segment.rotation_y,
            rotation_z: segment.rotation_z,
            fov: segment.fov,
            camera_distance: distance,
            zoom,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct InterpolatedPerspective {
    pub active: bool,
    pub params: PerspectiveParams,
}

impl Default for InterpolatedPerspective {
    fn default() -> Self {
        Self {
            active: false,
            params: PerspectiveParams::default(),
        }
    }
}

impl InterpolatedPerspective {
    pub fn new(cursor: PerspectiveSegmentsCursor) -> Self {
        let ease = bezier_easing::bezier_easing(0.42, 0.0, 0.58, 1.0).unwrap();

        if let Some(segment) = cursor.segment {
            let params = PerspectiveParams::from_segment(segment, cursor.time);

            let transition_in_end = segment.start + PERSPECTIVE_TRANSITION_DURATION;
            let transition_out_start = segment.end - PERSPECTIVE_TRANSITION_DURATION;

            let t = if cursor.time < transition_in_end {
                let raw = ((cursor.time - segment.start) / PERSPECTIVE_TRANSITION_DURATION)
                    .clamp(0.0, 1.0);
                ease(raw as f32) as f64
            } else if cursor.time >= transition_out_start {
                let raw =
                    ((segment.end - cursor.time) / PERSPECTIVE_TRANSITION_DURATION).clamp(0.0, 1.0);
                ease(raw as f32) as f64
            } else {
                1.0
            };

            let default = PerspectiveParams::default();
            Self {
                active: true,
                params: PerspectiveParams {
                    rotation_x: lerp(0.0, params.rotation_x, t),
                    rotation_y: lerp(0.0, params.rotation_y, t),
                    rotation_z: lerp(0.0, params.rotation_z, t),
                    fov: lerp(default.fov, params.fov, t),
                    camera_distance: lerp(default.camera_distance, params.camera_distance, t),
                    zoom: lerp(1.0, params.zoom, t),
                },
            }
        } else if let Some(next) = cursor.next_segment() {
            let gap = next.start - cursor.time;
            if gap < PERSPECTIVE_TRANSITION_DURATION {
                let raw = (1.0 - gap / PERSPECTIVE_TRANSITION_DURATION).clamp(0.0, 1.0);
                let t = ease(raw as f32) as f64;
                let target = PerspectiveParams::from_segment(next, next.start);

                Self {
                    active: true,
                    params: PerspectiveParams {
                        rotation_x: lerp(0.0, target.rotation_x, t),
                        rotation_y: lerp(0.0, target.rotation_y, t),
                        rotation_z: lerp(0.0, target.rotation_z, t),
                        fov: lerp(80.0, target.fov, t),
                        camera_distance: lerp(40.0, target.camera_distance, t),
                        zoom: lerp(1.0, target.zoom, t),
                    },
                }
            } else {
                Self::default()
            }
        } else {
            Self::default()
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn compute_inverse_mvp(&self, aspect: f32) -> [[f32; 4]; 4] {
        let p = &self.params;

        let render_distance = (p.camera_distance as f32 / 100.0) * 5.0 / (p.zoom as f32);
        let render_fov = (p.fov as f32 / 90.0) * 20.0;

        let model = Mat4::rotation_z(p.rotation_z as f32)
            .mul(&Mat4::rotation_y(p.rotation_y as f32))
            .mul(&Mat4::rotation_x(p.rotation_x as f32));

        let view = Mat4::translation(0.0, 0.0, -render_distance);

        let projection = Mat4::perspective(render_fov, aspect, 0.01, 1000.0);

        let mvp = projection.mul(&view).mul(&model);
        mvp.inverse().to_column_major()
    }

    pub fn plane_half_size(&self, aspect: f32) -> [f32; 2] {
        [aspect * 0.5, 0.5]
    }
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn ease_in_out(t: f64) -> f64 {
    if t < 0.5 {
        2.0 * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
    }
}
