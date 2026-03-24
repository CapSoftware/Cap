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

fn sdf_rect(p: vec2<f32>, half_size: vec2<f32>) -> f32 {
    let d = abs(p) - half_size;
    return length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0);
}

fn sdf_rounded_rect(p: vec2<f32>, half_size: vec2<f32>, radius: f32) -> f32 {
    let q = abs(p) - half_size + vec2<f32>(radius);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
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

fn clawd_body_sdf(p: vec2<f32>) -> f32 {
    let main_body = sdf_rect(p - vec2<f32>(0.0, 0.0), vec2<f32>(0.19, 0.155));

    let left_arm = sdf_rect(p - vec2<f32>(-0.225, -0.09), vec2<f32>(0.04, 0.065));
    let right_arm = sdf_rect(p - vec2<f32>(0.225, -0.09), vec2<f32>(0.04, 0.065));

    let left_foot = sdf_rect(p - vec2<f32>(-0.095, 0.21), vec2<f32>(0.055, 0.06));
    let right_foot = sdf_rect(p - vec2<f32>(0.095, 0.21), vec2<f32>(0.055, 0.06));

    var d = main_body;
    d = min(d, left_arm);
    d = min(d, right_arm);
    d = min(d, left_foot);
    d = min(d, right_foot);

    return d;
}

const BODY_COLOR: vec4<f32> = vec4<f32>(0.831, 0.518, 0.353, 1.0);
const OUTLINE_COLOR: vec4<f32> = vec4<f32>(1.0, 1.0, 1.0, 1.0);
const EYE_COLOR: vec4<f32> = vec4<f32>(0.05, 0.05, 0.05, 1.0);
const MOUTH_COLOR: vec4<f32> = vec4<f32>(0.12, 0.06, 0.04, 1.0);

@fragment
fn fs_main(@location(0) tex_coords: vec2<f32>) -> @location(0) vec4<f32> {
    let aa = 0.003;
    let outline_width = 0.018;

    let pitch = u.head_rotation.x;
    let yaw = u.head_rotation.y;
    let roll = u.head_rotation.z;

    let breath_scale = 1.0 + u.breathing_phase * 0.008;
    let bounce_offset = u.bounce * 0.015;

    var p = tex_coords - vec2<f32>(0.5, 0.48);
    p.y += bounce_offset;
    p = rotate_2d(p, roll * 0.25);
    p.x -= yaw * 0.025;
    p.y -= pitch * 0.02;
    p /= breath_scale;

    var color = u.bg_color;

    let body_d = clawd_body_sdf(p);

    let outline_d = body_d - outline_width;
    let outline_a = alpha_from_sdf(outline_d, aa * 2.0);
    color = blend_over(color, vec4<f32>(OUTLINE_COLOR.rgb, outline_a * OUTLINE_COLOR.a));

    let body_a = alpha_from_sdf(body_d, aa);
    color = blend_over(color, vec4<f32>(BODY_COLOR.rgb, body_a * BODY_COLOR.a));

    let eye_yaw_shift = yaw * 0.012;

    let eye_base_h = 0.028;
    let left_eye_h = eye_base_h * max(u.left_eye_open, 0.08);
    let left_eye_center = vec2<f32>(-0.075 + eye_yaw_shift, -0.04);
    let left_eye_d = sdf_rect(p - left_eye_center, vec2<f32>(0.028, left_eye_h));
    let left_eye_a = alpha_from_sdf(left_eye_d, aa) * body_a;
    color = blend_over(color, vec4<f32>(EYE_COLOR.rgb, left_eye_a));

    let right_eye_h = eye_base_h * max(u.right_eye_open, 0.08);
    let right_eye_center = vec2<f32>(0.075 + eye_yaw_shift, -0.04);
    let right_eye_d = sdf_rect(p - right_eye_center, vec2<f32>(0.028, right_eye_h));
    let right_eye_a = alpha_from_sdf(right_eye_d, aa) * body_a;
    color = blend_over(color, vec4<f32>(EYE_COLOR.rgb, right_eye_a));

    let mouth_height = u.mouth_open * 0.05;
    if u.mouth_open > 0.05 {
        let mouth_center = vec2<f32>(0.0 + eye_yaw_shift * 0.5, 0.155);
        let mouth_half = vec2<f32>(0.035, mouth_height * 0.5 + 0.005);
        let mouth_d = sdf_rounded_rect(p - mouth_center, mouth_half, 0.008);
        let mouth_a = alpha_from_sdf(mouth_d, aa) * body_a;
        color = blend_over(color, vec4<f32>(MOUTH_COLOR.rgb, mouth_a));
    }

    return color;
}
