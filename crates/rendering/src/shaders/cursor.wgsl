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

const MAX_ROTATION_RADIANS: f32 = 0.25;
const ROTATION_VELOCITY_SCALE: f32 = 0.003;

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

    let rotation_amount = uniforms.rotation_params.x;
    let base_rotation = uniforms.rotation_params.y;

    let motion_x = uniforms.motion_vector_strength.x;
    let normalized_velocity = clamp(motion_x * ROTATION_VELOCITY_SCALE, -1.0, 1.0);
    let velocity_rotation = normalized_velocity * MAX_ROTATION_RADIANS * rotation_amount;
    let rotation_angle = velocity_rotation + base_rotation;

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
    let blur_offset_uv = motion_vec * 0.45 / cursor_size;
    let blur_len = length(blur_offset_uv);

    if (blur_len < 0.005) {
        return textureSample(t_cursor, s_cursor, input.uv) * opacity;
    }

    let num_samples = 24;
    var color_sum = vec4<f32>(0.0);
    var alpha_sum = 0.0;
    var weight_sum = 0.0;

    let blur_center = 0.3;
    let blur_spread = 2.5;

    for (var i = 0; i < num_samples; i++) {
        let t = f32(i) / f32(num_samples - 1);
        let centered_t = t - blur_center;
        let sample_offset = blur_offset_uv * centered_t;
        let sample_uv = input.uv + sample_offset;

        let gauss_t = centered_t * blur_spread;
        var weight = exp(-gauss_t * gauss_t);

        if (centered_t > 0.0) {
            weight *= 1.0 + centered_t * 0.3;
        }

        let sample_color = textureSample(t_cursor, s_cursor, sample_uv);
        let premul_rgb = sample_color.rgb * sample_color.a;
        color_sum += vec4<f32>(premul_rgb * weight, 0.0);
        alpha_sum += sample_color.a * weight;
        weight_sum += weight;
    }

    let avg_alpha = alpha_sum / max(weight_sum, 0.001);
    var final_color: vec4<f32>;
    if (avg_alpha > 0.001) {
        let final_rgb = color_sum.rgb / max(alpha_sum, 0.001);
        final_color = vec4<f32>(final_rgb, avg_alpha);
    } else {
        final_color = vec4<f32>(0.0);
    }

    final_color *= opacity;
    return final_color;
}
