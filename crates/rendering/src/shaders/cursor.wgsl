struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct Uniforms {
    position_size: vec4<f32>,
    output_size: vec4<f32>,
    screen_bounds: vec4<f32>,
    motion_vector_strength: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

@group(0) @binding(1)
var t_cursor: texture_2d<f32>;

@group(0) @binding(2)
var s_cursor: sampler;

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

    // Calculate final position - centered around cursor position
    // Flip the Y coordinate by subtracting from output height
    var adjusted_pos = screen_pos;
    adjusted_pos.y = uniforms.output_size.y - adjusted_pos.y;  // Flip Y coordinate

    let final_pos = ((pos * cursor_size) + adjusted_pos) / uniforms.output_size.xy * 2.0 - 1.0;

    var output: VertexOutput;
    output.position = vec4<f32>(final_pos, 0.0, 1.0);
    output.uv = uvs[vertex_index];
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // Increase samples for higher quality blur
    let num_samples = 20;
    let base_sample = textureSample(t_cursor, s_cursor, input.uv);
    var color_sum = base_sample;
    var weight_sum = 1.0;

    // Calculate velocity magnitude for adaptive blur strength
    let motion_vec = uniforms.motion_vector_strength.xy;
    let blur_strength = uniforms.motion_vector_strength.z;
    let opacity = uniforms.motion_vector_strength.w;

    let motion_len = length(motion_vec);
    if (motion_len < 1e-4 || blur_strength < 0.001) {
        return textureSample(t_cursor, s_cursor, input.uv) * opacity;
    }

    let direction = motion_vec / motion_len;
    let max_offset = motion_len;

    for (var i = 0; i < num_samples; i++) {
        let t = f32(i) / f32(num_samples - 1);
        let eased = smoothstep(0.0, 1.0, t);
        let offset = direction * max_offset * eased;
        let sample_uv = input.uv + offset / uniforms.output_size.xy;

        // Sample with bilinear filtering
        let sample = textureSample(t_cursor, s_cursor, sample_uv);

        // Accumulate weighted sample
        let weight = 1.0 - t * 0.75;
        color_sum += sample * weight;
        weight_sum += weight;
    }

    var final_color = color_sum / weight_sum;
    final_color *= opacity;
    return final_color;
}
