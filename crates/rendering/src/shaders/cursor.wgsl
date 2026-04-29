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
    var positions = array<vec2<f32>, 4>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, -1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, -1.0)
    );

    var uvs = array<vec2<f32>, 4>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0)
    );

    let pos = positions[vertex_index];
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
    output.uv = uvs[vertex_index];
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let motion_vec = uniforms.motion_vector_strength.xy;
    let blur_strength = uniforms.motion_vector_strength.z;
    let opacity = uniforms.motion_vector_strength.w;

    let motion_len = length(motion_vec);
    if (motion_len < 0.5 || blur_strength < 0.001) {
        return textureSample(t_cursor, s_cursor, input.uv) * opacity;
    }

    let cursor_size = uniforms.position_size.zw;
    let velocity_uv = motion_vec / cursor_size;
    let vel_len = length(velocity_uv);

    if (vel_len < 0.005) {
        return textureSample(t_cursor, s_cursor, input.uv) * opacity;
    }

    let kernel_size = 21;
    let k = kernel_size - 1;
    let offset_base = -vel_len / 2.0 / vel_len - 0.5;

    var color = textureSample(t_cursor, s_cursor, input.uv);

    for (var i = 0; i < 20; i++) {
        let bias = velocity_uv * (f32(i) / f32(k) + offset_base);
        let sample_uv = input.uv + bias;
        color += textureSample(t_cursor, s_cursor, sample_uv);
    }

    color = color / f32(kernel_size);
    color *= opacity;
    return color;
}
