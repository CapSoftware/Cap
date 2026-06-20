struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct Uniforms {
    position_size: vec4<f32>,
    output_size: vec4<f32>,
    screen_bounds: vec4<f32>,
    motion_vector_strength: vec4<f32>,
    rotation_params: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

@group(0) @binding(1)
var t_cursor: texture_2d<f32>;

@group(0) @binding(2)
var s_cursor: sampler;

const MAX_ROTATION_RADIANS: f32 = 0.34906584;
const MAX_CURSOR_BLUR_UV: f32 = 0.24;

fn cursor_velocity_uv() -> vec2<f32> {
    let motion_vec = uniforms.motion_vector_strength.xy;
    let blur_strength = uniforms.motion_vector_strength.z;
    let cursor_size = uniforms.position_size.zw;
    let motion_len = length(motion_vec);

    if (motion_len < 0.5 || blur_strength < 0.001 || cursor_size.x <= 0.0 || cursor_size.y <= 0.0) {
        return vec2<f32>(0.0, 0.0);
    }

    let raw_velocity_uv = motion_vec / cursor_size;
    let raw_vel_len = length(raw_velocity_uv);

    if (raw_vel_len < 0.005) {
        return vec2<f32>(0.0, 0.0);
    }

    return raw_velocity_uv * min(1.0, MAX_CURSOR_BLUR_UV / raw_vel_len);
}

fn rotate_point(p: vec2<f32>, center: vec2<f32>, angle: f32) -> vec2<f32> {
    let cos_a = cos(angle);
    let sin_a = sin(angle);
    let translated = p - center;
    return vec2<f32>(
        translated.x * cos_a - translated.y * sin_a,
        translated.x * sin_a + translated.y * cos_a
    ) + center;
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var corners = array<vec2<f32>, 4>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0)
    );

    let blur_uv = cursor_velocity_uv();
    let uv_min = min(vec2<f32>(0.0, 0.0), -blur_uv);
    let uv_max = max(vec2<f32>(1.0, 1.0), vec2<f32>(1.0, 1.0) - blur_uv);
    let local_uv = uv_min + (uv_max - uv_min) * corners[vertex_index];
    let pos = vec2<f32>(local_uv.x, -local_uv.y);
    let screen_pos = uniforms.position_size.xy;
    let cursor_size = uniforms.position_size.zw;

    let base_rotation = uniforms.rotation_params.y;
    let x_movement_tilt = uniforms.rotation_params.z;

    let clamped_tilt = clamp(x_movement_tilt, -MAX_ROTATION_RADIANS, MAX_ROTATION_RADIANS);
    let rotation_angle = clamped_tilt + base_rotation;

    let pivot = vec2<f32>(0.0, 0.0);
    let rotated_pos = rotate_point(pos, pivot, rotation_angle);

    var adjusted_pos = screen_pos;
    adjusted_pos.y = uniforms.output_size.y - adjusted_pos.y;

    let final_pos = ((rotated_pos * cursor_size) + adjusted_pos) / uniforms.output_size.xy * 2.0 - 1.0;

    var output: VertexOutput;
    output.position = vec4<f32>(final_pos, 0.0, 1.0);
    output.uv = local_uv;
    return output;
}

fn sample_cursor(uv: vec2<f32>) -> vec4<f32> {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    return textureSample(t_cursor, s_cursor, uv);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let velocity_uv = cursor_velocity_uv();
    let blur_strength = uniforms.motion_vector_strength.z;
    let opacity = uniforms.motion_vector_strength.w;
    let base_color = sample_cursor(input.uv);

    if (length(velocity_uv) < 0.005 || blur_strength < 0.001) {
        return base_color * opacity;
    }

    let kernel_size = 21.0;
    let k = kernel_size - 1.0;
    var color = base_color;

    for (var i = 1; i <= 20; i = i + 1) {
        let bias = velocity_uv * (f32(i) / k);
        let sample_uv = input.uv + bias;
        color += sample_cursor(sample_uv);
    }

    color /= kernel_size;
    let blur_mix = clamp(blur_strength, 0.0, 1.0);
    return mix(base_color, color, blur_mix) * opacity;
}
