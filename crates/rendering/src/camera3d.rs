//! 3D camera transform for the composed content plane.
//!
//! Geometry: the content plane's longest side spans 2 world units, centered
//! at the origin facing +Z. The camera orbits via Euler YXZ (`tilt_y`,
//! `tilt_x`, `roll`), the plane itself rotates via `rotate_y`·`rotate_x`,
//! `zoom` is the camera distance, `pan_x`/`pan_y` truck the camera in its own
//! plane, and `fov` is the vertical field of view with no size compensation:
//! apparent size ∝ 1 / (zoom · tan(fov/2)).
//!
//!   view(p) = T(pan_x, pan_y, -zoom) · R_cam · R_obj · p
//!   R_cam = Ry(tilt_y)·Rx(tilt_x)·Rz(roll)   R_obj = Ry(rotate_y)·Rx(rotate_x)
//!
//! Keyframes are per-property tracks with a split-handle bezier easing: the
//! segment between two keyframes lerps the value linearly with time remapped
//! by cubic-bezier(P1 = left.out_easing ?? [0.65, 0],
//! P2 = right.in_easing ?? [0.35, 1]).
//!
//! Cap addition: `transition_in`/`transition_out` ease the whole effect from
//! the flat frame (zoom at the exact fill distance, all angles zero) into the
//! pose, so a segment always enters and leaves gracefully.

use cap_project::{Camera3DBlurMode, Camera3DKeyframe, Camera3DProperties, Camera3DSegment};

/// Default split handles: cubic ease-in-out.
const DEFAULT_OUT_EASING: [f64; 2] = [0.65, 0.0];
const DEFAULT_IN_EASING: [f64; 2] = [0.35, 1.0];

/// Blur strength is authored in pixels at this output height and scaled by the
/// renderer so preview and export match (same convention as mask effects).
pub const CAMERA3D_BLUR_BASE_HEIGHT: f64 = 1080.0;

/// Effective, fully-sampled 3D state for one frame.
#[derive(Clone, Copy, Debug)]
pub struct Camera3DFrame {
    /// `None` when the frame is exactly flat (warp pass can be skipped).
    pub pose: Option<Camera3DProperties>,
    /// `None` when no blur should render this frame.
    pub blur: Option<Camera3DBlurFrame>,
    /// Boundary ramp 0..1. Decorations that read wrong in 3D (the flat drop
    /// shadow baked into the content) fade out with this.
    pub activity: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera3DBlurFrame {
    pub mode: Camera3DBlurMode,
    /// Pixels at [`CAMERA3D_BLUR_BASE_HEIGHT`]; already boundary-ramped and
    /// bokeh-capped.
    pub strength: f64,
    pub falloff: f64,
    pub focus_x: f64,
    pub focus_y: f64,
    pub focus_size: f64,
    /// Radians.
    pub angle: f64,
    pub dir_position: f64,
    pub bokeh: bool,
}

/// Samples the active 3d segment at `frame_time`, or `None` when no segment
/// covers the frame (or the sampled state is visually flat with no blur).
pub fn interpolate_camera3d(
    frame_time: f64,
    segments: &[Camera3DSegment],
    aspect: f64,
) -> Option<Camera3DFrame> {
    let segment = segments
        .iter()
        .filter(|s| s.enabled)
        .find(|s| frame_time >= s.start && frame_time <= s.end)?;

    let rel = frame_time - segment.start;
    let tracks = &segment.tracks;
    let base = &segment.properties;
    let blur_base = &segment.blur;

    let pose = Camera3DProperties {
        tilt_x: sample_track(base.tilt_x, &tracks.tilt_x, rel),
        tilt_y: sample_track(base.tilt_y, &tracks.tilt_y, rel),
        roll: sample_track(base.roll, &tracks.roll, rel),
        rotate_x: sample_track(base.rotate_x, &tracks.rotate_x, rel),
        rotate_y: sample_track(base.rotate_y, &tracks.rotate_y, rel),
        fov: sample_track(base.fov, &tracks.fov, rel),
        zoom: sample_track(base.zoom, &tracks.zoom, rel),
        pan_x: sample_track(base.pan_x, &tracks.pan_x, rel),
        pan_y: sample_track(base.pan_y, &tracks.pan_y, rel),
    };

    let blur = Camera3DBlurFrame {
        mode: blur_base.mode,
        strength: sample_track(blur_base.strength, &tracks.blur_strength, rel),
        falloff: sample_track(blur_base.falloff, &tracks.blur_falloff, rel),
        focus_x: sample_track(blur_base.focus_x, &tracks.blur_focus_x, rel),
        focus_y: sample_track(blur_base.focus_y, &tracks.blur_focus_y, rel),
        focus_size: sample_track(blur_base.focus_size, &tracks.blur_focus_size, rel),
        angle: sample_track(blur_base.angle, &tracks.blur_angle, rel).to_radians(),
        dir_position: sample_track(blur_base.dir_position, &tracks.blur_dir_position, rel),
        bokeh: blur_base.bokeh,
    };

    let activity = boundary_activity(segment, frame_time);
    Some(effective_frame(&pose, &blur, activity, aspect))
}

fn effective_frame(
    pose: &Camera3DProperties,
    blur: &Camera3DBlurFrame,
    activity: f64,
    aspect: f64,
) -> Camera3DFrame {
    let fov = pose.fov.clamp(1.0, 179.0);
    let (_, hy) = plane_half_extents(aspect);
    // The camera distance at which the plane exactly fills the frame — the
    // "flat" end of the boundary ramp.
    let fill_zoom = hy / (fov.to_radians() / 2.0).tan();

    let eased = pose_from_activity(pose, activity, fill_zoom);

    let flat = eased.tilt_x.abs() < 1e-3
        && eased.tilt_y.abs() < 1e-3
        && eased.roll.abs() < 1e-3
        && eased.rotate_x.abs() < 1e-3
        && eased.rotate_y.abs() < 1e-3
        && eased.pan_x.abs() < 1e-4
        && eased.pan_y.abs() < 1e-4
        && (eased.zoom - fill_zoom).abs() < 1e-4;

    let mut strength = blur.strength.max(0.0) * activity;
    if blur.bokeh {
        strength = strength.min(20.0);
    } else {
        strength = strength.min(60.0);
    }
    let blur_active =
        blur.mode != Camera3DBlurMode::None && strength >= 0.5 && strength.is_finite();

    Camera3DFrame {
        pose: (!flat).then_some(eased),
        blur: blur_active.then_some(Camera3DBlurFrame { strength, ..*blur }),
        activity: activity.clamp(0.0, 1.0),
    }
}

fn pose_from_activity(
    pose: &Camera3DProperties,
    activity: f64,
    fill_zoom: f64,
) -> Camera3DProperties {
    let a = activity.clamp(0.0, 1.0);
    let zoom = pose.zoom.clamp(0.05, 100.0);
    Camera3DProperties {
        tilt_x: pose.tilt_x * a,
        tilt_y: pose.tilt_y * a,
        roll: pose.roll * a,
        rotate_x: pose.rotate_x * a,
        rotate_y: pose.rotate_y * a,
        fov: pose.fov,
        zoom: fill_zoom + (zoom - fill_zoom) * a,
        pan_x: pose.pan_x * a,
        pan_y: pose.pan_y * a,
    }
}

/// 0 at the segment edges, ramping to 1 over `transition_in`/`transition_out`.
fn boundary_activity(segment: &Camera3DSegment, frame_time: f64) -> f64 {
    let len = (segment.end - segment.start).max(0.0);
    let half = len / 2.0;
    let t_in = segment.transition_in.clamp(0.0, half);
    let t_out = segment.transition_out.clamp(0.0, half);

    let a_in = if t_in > 0.0 {
        ((frame_time - segment.start) / t_in).clamp(0.0, 1.0)
    } else {
        1.0
    };
    let a_out = if t_out > 0.0 {
        ((segment.end - frame_time) / t_out).clamp(0.0, 1.0)
    } else {
        1.0
    };

    bezier_ease(DEFAULT_OUT_EASING, DEFAULT_IN_EASING, a_in)
        * bezier_ease(DEFAULT_OUT_EASING, DEFAULT_IN_EASING, a_out)
}

/// Samples one per-property track: base value when empty, hold outside the
/// keyed range, split-handle bezier lerp between neighbours.
pub fn sample_track(base: f64, keys: &[Camera3DKeyframe], time: f64) -> f64 {
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
            let progress = ((time - prev.time) / span).clamp(0.0, 1.0);
            let p1 = prev.out_easing.unwrap_or(DEFAULT_OUT_EASING);
            let p2 = next.in_easing.unwrap_or(DEFAULT_IN_EASING);
            let eased = bezier_ease(p1, p2, progress);
            return prev.value + (next.value - prev.value) * eased;
        }
    }

    sorted.last().map(|k| k.value).unwrap_or(base)
}

fn bezier_component(p1: f64, p2: f64, t: f64) -> f64 {
    let inv = 1.0 - t;
    3.0 * inv * inv * t * p1 + 3.0 * inv * t * t * p2 + t * t * t
}

fn bezier_derivative(p1: f64, p2: f64, t: f64) -> f64 {
    let a = 1.0 - 3.0 * p2 + 3.0 * p1;
    let b = 3.0 * p2 - 6.0 * p1;
    let c = 3.0 * p1;
    (3.0 * a * t + 2.0 * b) * t + c
}

/// Cubic-bezier timing with control points P1/P2 (P0=(0,0), P3=(1,1)):
/// 8 Newton iterations then bisection.
pub fn bezier_ease(p1: [f64; 2], p2: [f64; 2], t: f64) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    let [x1, y1] = p1;
    let [x2, y2] = p2;
    // Linear fast path ([0,0]/[1,1] handles).
    if x1 == y1 && x2 == y2 && x1 == 0.0 && x2 == 1.0 {
        return t;
    }

    let mut guess = t;
    for _ in 0..8 {
        let error = bezier_component(x1, x2, guess) - t;
        if error.abs() < 1e-5 {
            return bezier_component(y1, y2, guess);
        }
        let slope = bezier_derivative(x1, x2, guess);
        if slope.abs() < 1e-6 {
            break;
        }
        guess -= error / slope;
    }

    let mut lo = 0.0;
    let mut hi = 1.0;
    guess = t;
    for _ in 0..30 {
        let error = bezier_component(x1, x2, guess) - t;
        if error.abs() < 1e-5 {
            break;
        }
        if error > 0.0 {
            hi = guess;
        } else {
            lo = guess;
        }
        guess = (lo + hi) / 2.0;
    }
    bezier_component(y1, y2, guess)
}

/// Half-extents of the content plane: the longest side spans 2 world units.
pub fn plane_half_extents(aspect: f64) -> (f64, f64) {
    let aspect = if aspect.is_finite() && aspect > 0.0 {
        aspect
    } else {
        1.0
    };
    if aspect >= 1.0 {
        (1.0, 1.0 / aspect)
    } else {
        (aspect, 1.0)
    }
}

/// The 2D zoom while a 3D pose is active: magnify the card on screen by
/// `amount` about the zoom target (given as content-frame UV, y-down). The
/// target eases toward frame center as the magnification grows, matching the
/// flat zoom's framing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera3DScreenZoom {
    pub content_uv: cap_project::XY<f64>,
    pub amount: f64,
}

/// Rows of the 3×3 inverse homography mapping y-up NDC (x, y, 1) back to
/// plane coordinates (X·w, Y·w, w), plus the plane half-extents for UV
/// mapping in the shader.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera3DHomography {
    pub inverse_rows: [[f32; 3]; 3],
    pub half_extents: (f32, f32),
}

type Mat3 = [[f64; 3]; 3];

fn mat3_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for (i, out_row) in out.iter_mut().enumerate() {
        for (j, cell) in out_row.iter_mut().enumerate() {
            *cell = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

fn rot_x3(theta: f64) -> Mat3 {
    let (s, c) = theta.sin_cos();
    [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]
}

fn rot_y3(theta: f64) -> Mat3 {
    let (s, c) = theta.sin_cos();
    [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]
}

fn rot_z3(theta: f64) -> Mat3 {
    let (s, c) = theta.sin_cos();
    [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
}

/// Builds the inverse homography for a pose, or `None` when degenerate.
/// `screen_zoom` composes the 2D zoom as an NDC magnification of the card.
pub fn camera3d_inverse_homography(
    props: &Camera3DProperties,
    aspect: f64,
    screen_zoom: Option<&Camera3DScreenZoom>,
) -> Option<Camera3DHomography> {
    let aspect = if aspect.is_finite() && aspect > 0.0 {
        aspect
    } else {
        1.0
    };
    let (hx, hy) = plane_half_extents(aspect);

    let fov = props.fov.clamp(1.0, 179.0).to_radians();
    let f = 1.0 / (fov / 2.0).tan();
    let zoom = props.zoom.clamp(0.05, 100.0);

    let r_cam = mat3_mul(
        &rot_y3(props.tilt_y.to_radians()),
        &mat3_mul(
            &rot_x3(props.tilt_x.to_radians()),
            &rot_z3(props.roll.to_radians()),
        ),
    );
    let r_obj = mat3_mul(
        &rot_y3(props.rotate_y.to_radians()),
        &rot_x3(props.rotate_x.to_radians()),
    );
    let r = mat3_mul(&r_cam, &r_obj);

    // view = R·(X, Y, 0) + (pan_x, pan_y, -zoom); homography on [X, Y, 1]:
    let fx = f / aspect;
    let mut forward = [
        [fx * r[0][0], fx * r[0][1], fx * props.pan_x],
        [f * r[1][0], f * r[1][1], f * props.pan_y],
        [-r[2][0], -r[2][1], zoom],
    ];

    if let Some(screen_zoom) = screen_zoom
        && screen_zoom.amount > 1.001
        && screen_zoom.amount.is_finite()
    {
        // Project the zoom target (content UV, y-down) to NDC through the
        // pose, then scale about it. The fixed point slides toward frame
        // center as `q / amount`, mirroring the flat zoom's centering.
        let plane_x = (2.0 * screen_zoom.content_uv.x - 1.0) * hx;
        let plane_y = (1.0 - 2.0 * screen_zoom.content_uv.y) * hy;
        let w = forward[2][0] * plane_x + forward[2][1] * plane_y + forward[2][2];
        if w > 1e-6 {
            let qx = (forward[0][0] * plane_x + forward[0][1] * plane_y + forward[0][2]) / w;
            let qy = (forward[1][0] * plane_x + forward[1][1] * plane_y + forward[1][2]) / w;
            let amount = screen_zoom.amount;
            let recenter = amount - 1.0 / amount;
            let magnify = [
                [amount, 0.0, -qx * recenter],
                [0.0, amount, -qy * recenter],
                [0.0, 0.0, 1.0],
            ];
            forward = mat3_mul(&magnify, &forward);
        }
    }

    invert3(&forward).map(|inv| Camera3DHomography {
        inverse_rows: inv.map(|row| row.map(|v| v as f32)),
        half_extents: (hx as f32, hy as f32),
    })
}

fn invert3(m: &[[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let c00 = m[1][1] * m[2][2] - m[1][2] * m[2][1];
    let c01 = m[1][2] * m[2][0] - m[1][0] * m[2][2];
    let c02 = m[1][0] * m[2][1] - m[1][1] * m[2][0];

    let det = m[0][0] * c00 + m[0][1] * c01 + m[0][2] * c02;
    if !det.is_finite() || det.abs() < 1e-12 {
        return None;
    }
    let inv_det = 1.0 / det;

    Some([
        [
            c00 * inv_det,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * inv_det,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_det,
        ],
        [
            c01 * inv_det,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_det,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * inv_det,
        ],
        [
            c02 * inv_det,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * inv_det,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_det,
        ],
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{Camera3DBlur, Camera3DTracks};

    const ASPECT: f64 = 16.0 / 9.0;
    const HY: f64 = 9.0 / 16.0;

    fn apply3(rows: &[[f32; 3]; 3], v: [f64; 3]) -> [f64; 3] {
        let mut out = [0.0; 3];
        for (i, row) in rows.iter().enumerate() {
            out[i] = row.iter().zip(v.iter()).map(|(a, b)| *a as f64 * b).sum();
        }
        out
    }

    fn ndc_to_plane(h: &Camera3DHomography, ndc: [f64; 2]) -> [f64; 2] {
        let q = apply3(&h.inverse_rows, [ndc[0], ndc[1], 1.0]);
        assert!(q[2] > 0.0, "point must be in front of the camera");
        [q[0] / q[2], q[1] / q[2]]
    }

    fn forward_ndc(h: &Camera3DHomography, plane: [f64; 2]) -> [f64; 2] {
        let inv = h.inverse_rows.map(|r| r.map(|v| v as f64));
        let fwd = invert3(&inv).unwrap();
        let s = apply3(&fwd.map(|r| r.map(|v| v as f32)), [plane[0], plane[1], 1.0]);
        [s[0] / s[2], s[1] / s[2]]
    }

    fn assert_close(a: f64, b: f64, eps: f64, label: &str) {
        assert!((a - b).abs() < eps, "{label}: {a} vs {b}");
    }

    fn fill_zoom(fov_deg: f64) -> f64 {
        HY / (fov_deg.to_radians() / 2.0).tan()
    }

    #[test]
    fn fill_distance_maps_frame_corners_to_plane_corners() {
        for fov in [24.0, 45.0, 60.0] {
            let props = Camera3DProperties {
                fov,
                zoom: fill_zoom(fov),
                ..Default::default()
            };
            let h = camera3d_inverse_homography(&props, ASPECT, None).unwrap();
            let p = ndc_to_plane(&h, [1.0, 1.0]);
            assert_close(p[0], 1.0, 1e-4, "corner x");
            assert_close(p[1], HY, 1e-4, "corner y");
        }
    }

    #[test]
    fn default_framing_matches_expected_size() {
        // fov 45 / zoom 2.25 puts the 16:9 card at ~60% of frame height
        // (size law: size ∝ 1/(zoom·tan(fov/2))).
        let props = Camera3DProperties {
            zoom: 2.25,
            ..Default::default()
        };
        let h = camera3d_inverse_homography(&props, ASPECT, None).unwrap();
        let top = forward_ndc(&h, [0.0, HY]);
        assert_close(top[1], 0.6035, 1e-3, "subject half-height in NDC");

        // fov 24 / zoom 4.5 (the reset pose) frames almost identically.
        let props = Camera3DProperties {
            fov: 24.0,
            zoom: 4.5,
            ..Default::default()
        };
        let h = camera3d_inverse_homography(&props, ASPECT, None).unwrap();
        let top = forward_ndc(&h, [0.0, HY]);
        assert_close(top[1], 0.5876, 1e-3, "long-lens half-height");
    }

    #[test]
    fn fov_is_not_size_compensated() {
        let at = |fov: f64| {
            let props = Camera3DProperties {
                fov,
                zoom: 2.0,
                ..Default::default()
            };
            let h = camera3d_inverse_homography(&props, ASPECT, None).unwrap();
            forward_ndc(&h, [0.0, HY])[1]
        };
        // Wider fov at the same distance makes the subject smaller.
        assert!(at(100.0) < at(45.0));
        assert!(at(45.0) < at(10.0));
    }

    #[test]
    fn zoom_is_distance() {
        let at = |zoom: f64| {
            let props = Camera3DProperties {
                zoom,
                ..Default::default()
            };
            let h = camera3d_inverse_homography(&props, ASPECT, None).unwrap();
            forward_ndc(&h, [0.0, HY])[1]
        };
        assert!(at(4.0) < at(2.0), "further away is smaller");
        assert_close(at(4.0), at(2.0) / 2.0, 1e-6, "size ∝ 1/zoom");
    }

    #[test]
    fn pan_moves_subject_in_screen_direction() {
        let props = Camera3DProperties {
            pan_x: 0.5,
            pan_y: 0.25,
            ..Default::default()
        };
        let h = camera3d_inverse_homography(&props, ASPECT, None).unwrap();
        let center = forward_ndc(&h, [0.0, 0.0]);
        assert!(center[0] > 0.0, "+pan_x moves subject right");
        assert!(center[1] > 0.0, "+pan_y moves subject up");
    }

    #[test]
    fn screen_zoom_magnifies_about_target() {
        // Flat pose at the fill distance: the card exactly fills the frame,
        // so a 2x screen zoom at content center doubles every NDC coordinate.
        let props = Camera3DProperties {
            zoom: fill_zoom(45.0),
            ..Default::default()
        };
        let zoom = Camera3DScreenZoom {
            content_uv: cap_project::XY::new(0.5, 0.5),
            amount: 2.0,
        };
        let h = camera3d_inverse_homography(&props, ASPECT, Some(&zoom)).unwrap();
        let p = ndc_to_plane(&h, [1.0, 1.0]);
        assert_close(p[0], 0.5, 1e-4, "half plane x visible");
        assert_close(p[1], HY / 2.0, 1e-4, "half plane y visible");

        // An off-center target slides toward frame center as q / amount.
        let zoom = Camera3DScreenZoom {
            content_uv: cap_project::XY::new(0.75, 0.5),
            amount: 2.0,
        };
        let h = camera3d_inverse_homography(&props, ASPECT, Some(&zoom)).unwrap();
        // Content u 0.75 sits at plane x 0.5·hx, NDC 0.5 unzoomed.
        let target = forward_ndc(&h, [0.5, 0.0]);
        assert_close(target[0], 0.25, 1e-4, "target recenters as q/amount");
        assert_close(target[1], 0.0, 1e-4, "target y");

        // Amount 1 (or None) leaves the homography untouched.
        let identity_zoom = Camera3DScreenZoom {
            content_uv: cap_project::XY::new(0.2, 0.9),
            amount: 1.0,
        };
        let with_zoom = camera3d_inverse_homography(&props, ASPECT, Some(&identity_zoom)).unwrap();
        let without = camera3d_inverse_homography(&props, ASPECT, None).unwrap();
        assert_eq!(with_zoom.inverse_rows, without.inverse_rows);
    }

    #[test]
    fn tilt_y_positive_recedes_right_edge() {
        let props = Camera3DProperties {
            tilt_y: 30.0,
            ..Default::default()
        };
        let h = camera3d_inverse_homography(&props, ASPECT, None).unwrap();
        let inv = h.inverse_rows.map(|r| r.map(|v| v as f64));
        let fwd = invert3(&inv).unwrap();
        let w_right = apply3(&fwd.map(|r| r.map(|v| v as f32)), [1.0, 0.0, 1.0])[2];
        let w_left = apply3(&fwd.map(|r| r.map(|v| v as f32)), [-1.0, 0.0, 1.0])[2];
        assert!(w_right > w_left, "right edge should be further away");
    }

    #[test]
    fn rotate_x_positive_brings_top_closer() {
        // Matches the CSS-3D preview (rotateX(-rotateX) in y-down CSS):
        // positive rotate_x tips the top toward the viewer.
        let props = Camera3DProperties {
            rotate_x: 30.0,
            ..Default::default()
        };
        let h = camera3d_inverse_homography(&props, ASPECT, None).unwrap();
        let inv = h.inverse_rows.map(|r| r.map(|v| v as f64));
        let fwd = invert3(&inv).unwrap();
        let w_top = apply3(&fwd.map(|r| r.map(|v| v as f32)), [0.0, HY, 1.0])[2];
        let w_bottom = apply3(&fwd.map(|r| r.map(|v| v as f32)), [0.0, -HY, 1.0])[2];
        assert!(w_top < w_bottom, "top should be closer");
    }

    #[test]
    fn track_sampling_holds_and_lerps() {
        let keys = vec![
            Camera3DKeyframe {
                time: 1.0,
                value: 10.0,
                out_easing: Some([0.0, 0.0]),
                in_easing: None,
            },
            Camera3DKeyframe {
                time: 3.0,
                value: 20.0,
                out_easing: None,
                in_easing: Some([1.0, 1.0]),
            },
        ];
        assert_eq!(sample_track(5.0, &[], 0.0), 5.0);
        assert_eq!(sample_track(5.0, &keys, 0.0), 10.0,);
        // Linear handles ([0,0]/[1,1]) give an exact linear midpoint.
        assert_close(sample_track(5.0, &keys, 2.0), 15.0, 1e-9, "linear mid");
        assert_eq!(sample_track(5.0, &keys, 9.0), 20.0);
    }

    #[test]
    fn default_handles_are_cubic_ease_in_out() {
        let keys = vec![
            Camera3DKeyframe {
                time: 0.0,
                value: 0.0,
                out_easing: None,
                in_easing: None,
            },
            Camera3DKeyframe {
                time: 1.0,
                value: 1.0,
                out_easing: None,
                in_easing: None,
            },
        ];
        // cubic-bezier(0.65, 0, 0.35, 1): slow start, midpoint exactly 0.5.
        let quarter = sample_track(0.0, &keys, 0.25);
        assert!(
            quarter < 0.15,
            "eased quarter should lag linear, got {quarter}"
        );
        assert_close(sample_track(0.0, &keys, 0.5), 0.5, 1e-4, "eased mid");
    }

    fn segment() -> Camera3DSegment {
        Camera3DSegment {
            start: 2.0,
            end: 8.0,
            enabled: true,
            properties: Camera3DProperties {
                tilt_y: 26.0,
                tilt_x: -28.0,
                zoom: 1.59,
                ..Default::default()
            },
            blur: Camera3DBlur::default(),
            tracks: Camera3DTracks::default(),
            transition_in: 0.5,
            transition_out: 0.5,
        }
    }

    #[test]
    fn outside_segments_is_none() {
        assert!(interpolate_camera3d(1.0, &[segment()], ASPECT).is_none());
        assert!(interpolate_camera3d(9.0, &[segment()], ASPECT).is_none());
        assert!(interpolate_camera3d(5.0, &[], ASPECT).is_none());
    }

    #[test]
    fn segment_edges_ramp_from_flat() {
        let seg = segment();
        // At the exact edge the pose is flat (skipped) and blur is off.
        let frame = interpolate_camera3d(2.0, std::slice::from_ref(&seg), ASPECT).unwrap();
        assert!(frame.pose.is_none());
        assert!(frame.blur.is_none());

        let mid_ramp = interpolate_camera3d(2.25, std::slice::from_ref(&seg), ASPECT)
            .unwrap()
            .pose
            .unwrap();
        assert!(mid_ramp.tilt_y > 0.0 && mid_ramp.tilt_y < 26.0);
        // The ramp dollies from the fill distance toward the pose zoom.
        let fill = fill_zoom(45.0);
        let (lo, hi) = (fill.min(1.59), fill.max(1.59));
        assert!(
            mid_ramp.zoom > lo && mid_ramp.zoom < hi,
            "mid-ramp zoom {} should sit between {lo} and {hi}",
            mid_ramp.zoom
        );

        let settled = interpolate_camera3d(5.0, std::slice::from_ref(&seg), ASPECT)
            .unwrap()
            .pose
            .unwrap();
        assert_close(settled.tilt_y, 26.0, 1e-9, "settled tilt_y");
        assert_close(settled.zoom, 1.59, 1e-9, "settled zoom");
    }

    #[test]
    fn blur_requires_mode_and_strength() {
        let mut seg = segment();
        seg.transition_in = 0.0;
        seg.transition_out = 0.0;
        seg.blur.strength = 19.0;
        // Mode none: no blur even with strength.
        let frame = interpolate_camera3d(5.0, std::slice::from_ref(&seg), ASPECT).unwrap();
        assert!(frame.blur.is_none());

        seg.blur.mode = Camera3DBlurMode::Radial;
        let frame = interpolate_camera3d(5.0, std::slice::from_ref(&seg), ASPECT).unwrap();
        let blur = frame.blur.unwrap();
        assert_close(blur.strength, 19.0, 1e-9, "blur strength");

        // Bokeh caps strength at 20.
        seg.blur.bokeh = true;
        seg.blur.strength = 45.0;
        let frame = interpolate_camera3d(5.0, std::slice::from_ref(&seg), ASPECT).unwrap();
        assert_close(frame.blur.unwrap().strength, 20.0, 1e-9, "bokeh cap");
    }

    #[test]
    fn blur_is_keyframable() {
        let mut seg = segment();
        seg.transition_in = 0.0;
        seg.transition_out = 0.0;
        seg.blur.mode = Camera3DBlurMode::TiltShift;
        seg.tracks.blur_strength = vec![
            Camera3DKeyframe {
                time: 0.0,
                value: 0.0,
                out_easing: Some([0.0, 0.0]),
                in_easing: None,
            },
            Camera3DKeyframe {
                time: 6.0,
                value: 30.0,
                out_easing: None,
                in_easing: Some([1.0, 1.0]),
            },
        ];
        let frame = interpolate_camera3d(5.0, std::slice::from_ref(&seg), ASPECT).unwrap();
        assert_close(frame.blur.unwrap().strength, 15.0, 1e-6, "keyed strength");
    }
}
