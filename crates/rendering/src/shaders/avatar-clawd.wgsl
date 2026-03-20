struct AvatarUniforms {
    head_rotation: vec3<f32>,
    mouth_open: f32,
    left_eye_open: f32,
    right_eye_open: f32,
    breathing_phase: f32,
    bounce: f32,
    bg_color: vec4<f32>,
    _padding: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: AvatarUniforms;

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(i32(in_vertex_index & 1u) * 4 - 1);
    let y = f32(i32(in_vertex_index & 2u) * 2 - 1);
    out.tex_coords = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
    out.clip_position = vec4<f32>(x, y, 0.0, 1.0);
    return out;
}

fn sdf_rounded_rect(p: vec2<f32>, half_size: vec2<f32>, radius: f32) -> f32 {
    let q = abs(p) - half_size + vec2<f32>(radius);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

fn sdf_rect(p: vec2<f32>, half_size: vec2<f32>) -> f32 {
    let d = abs(p) - half_size;
    return length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0);
}

fn sdf_ellipse(p: vec2<f32>, radii: vec2<f32>) -> f32 {
    let n = p / radii;
    return (length(n) - 1.0) * min(radii.x, radii.y);
}

fn alpha_from_sdf(d: f32, aa: f32) -> f32 {
    return 1.0 - smoothstep(-aa, aa, d);
}

fn blend_over(base: vec4<f32>, top: vec4<f32>) -> vec4<f32> {
    let a = top.a + base.a * (1.0 - top.a);
    if a < 0.001 {
        return vec4<f32>(0.0);
    }
    let rgb = (top.rgb * top.a + base.rgb * base.a * (1.0 - top.a)) / a;
    return vec4<f32>(rgb, a);
}

fn rotate_2d(p: vec2<f32>, angle: f32) -> vec2<f32> {
    let c = cos(angle);
    let s = sin(angle);
    return vec2<f32>(p.x * c - p.y * s, p.x * s + p.y * c);
}

const BODY_COLOR: vec4<f32> = vec4<f32>(0.831, 0.518, 0.353, 1.0);
const EYE_COLOR: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 1.0);
const HIGHLIGHT_COLOR: vec4<f32> = vec4<f32>(1.0, 1.0, 1.0, 0.7);
const MOUTH_COLOR: vec4<f32> = vec4<f32>(0.15, 0.08, 0.05, 1.0);
const SHADOW_COLOR: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 0.12);

@fragment
fn fs_main(@location(0) tex_coords: vec2<f32>) -> @location(0) vec4<f32> {
    let aa = 0.004;

    let pitch = u.head_rotation.x;
    let yaw = u.head_rotation.y;
    let roll = u.head_rotation.z;

    let breath_scale = 1.0 + u.breathing_phase * 0.012;
    let bounce_offset = u.bounce * 0.025;

    var p = tex_coords - vec2<f32>(0.5, 0.5);
    p.y += bounce_offset;
    p = rotate_2d(p, roll * 0.3);
    p.x -= yaw * 0.03;
    p.y -= pitch * 0.03;
    p /= breath_scale;

    var color = u.bg_color;

    let shadow_p = vec2<f32>(p.x, p.y - 0.195);
    let shadow_d = sdf_ellipse(shadow_p, vec2<f32>(0.17, 0.025));
    let shadow_a = alpha_from_sdf(shadow_d, aa * 4.0) * SHADOW_COLOR.a;
    color = blend_over(color, vec4<f32>(SHADOW_COLOR.rgb, shadow_a));

    let body_half = vec2<f32>(0.18, 0.16);
    let body_d = sdf_rounded_rect(p, body_half, 0.025);
    let body_a = alpha_from_sdf(body_d, aa);
    color = blend_over(color, vec4<f32>(BODY_COLOR.rgb, body_a * BODY_COLOR.a));

    let left_arm_center = vec2<f32>(-0.215, -0.08);
    let left_arm_p = p - left_arm_center;
    let left_arm_d = sdf_rounded_rect(left_arm_p, vec2<f32>(0.045, 0.05), 0.012);
    let left_arm_a = alpha_from_sdf(left_arm_d, aa);
    color = blend_over(color, vec4<f32>(BODY_COLOR.rgb, left_arm_a * BODY_COLOR.a));

    let right_arm_center = vec2<f32>(0.215, -0.08);
    let right_arm_p = p - right_arm_center;
    let right_arm_d = sdf_rounded_rect(right_arm_p, vec2<f32>(0.045, 0.05), 0.012);
    let right_arm_a = alpha_from_sdf(right_arm_d, aa);
    color = blend_over(color, vec4<f32>(BODY_COLOR.rgb, right_arm_a * BODY_COLOR.a));

    let left_foot_center = vec2<f32>(-0.08, 0.19);
    let left_foot_p = p - left_foot_center;
    let left_foot_d = sdf_rounded_rect(left_foot_p, vec2<f32>(0.06, 0.04), 0.01);
    let left_foot_a = alpha_from_sdf(left_foot_d, aa);
    color = blend_over(color, vec4<f32>(BODY_COLOR.rgb, left_foot_a * BODY_COLOR.a));

    let right_foot_center = vec2<f32>(0.08, 0.19);
    let right_foot_p = p - right_foot_center;
    let right_foot_d = sdf_rounded_rect(right_foot_p, vec2<f32>(0.06, 0.04), 0.01);
    let right_foot_a = alpha_from_sdf(right_foot_d, aa);
    color = blend_over(color, vec4<f32>(BODY_COLOR.rgb, right_foot_a * BODY_COLOR.a));

    let eye_base_h = 0.032;
    let left_eye_h = eye_base_h * max(u.left_eye_open, 0.05);
    let left_eye_center = vec2<f32>(-0.065, -0.03);
    let left_eye_p = p - left_eye_center;
    let left_eye_d = sdf_rect(left_eye_p, vec2<f32>(0.03, left_eye_h));
    let left_eye_a = alpha_from_sdf(left_eye_d, aa);
    color = blend_over(color, vec4<f32>(EYE_COLOR.rgb, left_eye_a * EYE_COLOR.a * body_a));

    let right_eye_h = eye_base_h * max(u.right_eye_open, 0.05);
    let right_eye_center = vec2<f32>(0.065, -0.03);
    let right_eye_p = p - right_eye_center;
    let right_eye_d = sdf_rect(right_eye_p, vec2<f32>(0.03, right_eye_h));
    let right_eye_a = alpha_from_sdf(right_eye_d, aa);
    color = blend_over(color, vec4<f32>(EYE_COLOR.rgb, right_eye_a * EYE_COLOR.a * body_a));

    let highlight_offset = vec2<f32>(-0.012 + yaw * 0.015, -0.012);
    let highlight_size = vec2<f32>(0.01, 0.01);

    let lh_p = p - (left_eye_center + highlight_offset);
    let lh_d = sdf_rect(lh_p, highlight_size);
    let lh_a = alpha_from_sdf(lh_d, aa) * HIGHLIGHT_COLOR.a * step(0.3, u.left_eye_open);
    color = blend_over(color, vec4<f32>(HIGHLIGHT_COLOR.rgb, lh_a * body_a));

    let rh_p = p - (right_eye_center + highlight_offset);
    let rh_d = sdf_rect(rh_p, highlight_size);
    let rh_a = alpha_from_sdf(rh_d, aa) * HIGHLIGHT_COLOR.a * step(0.3, u.right_eye_open);
    color = blend_over(color, vec4<f32>(HIGHLIGHT_COLOR.rgb, rh_a * body_a));

    let mouth_height = u.mouth_open * 0.045;
    if u.mouth_open > 0.01 {
        let mouth_center = vec2<f32>(0.0, 0.1 + mouth_height * 0.3);
        let mouth_p = p - mouth_center;
        let mouth_d = sdf_rounded_rect(mouth_p, vec2<f32>(0.055, mouth_height), 0.015);
        let mouth_a = alpha_from_sdf(mouth_d, aa);
        color = blend_over(color, vec4<f32>(MOUTH_COLOR.rgb, mouth_a * MOUTH_COLOR.a * body_a));
    }

    return color;
}
