struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct Uniforms {
    position: vec4<f32>,
    size: vec4<f32>,
    output_size: vec4<f32>,
    screen_bounds: vec4<f32>,
    cursor_size: f32,
    last_click_time: f32,
    velocity: vec2<f32>,
    motion_blur_amount: f32,
    hotspot: vec2<f32>,
    _alignment: vec4<f32>,
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

    let pos = positions[vertex_index] - uniforms.hotspot;
    let size = uniforms.size.xy;
    let screen_pos = uniforms.position.xy;

    let scaled_size = size * uniforms.cursor_size;

    // Calculate final position - centered around cursor position
    // Flip the Y coordinate by subtracting from output height
    var adjusted_pos = screen_pos;
    adjusted_pos.y = uniforms.output_size.y - adjusted_pos.y;  // Flip Y coordinate

    let final_pos = ((pos * scaled_size) + adjusted_pos) / uniforms.output_size.xy * 2.0 - 1.0;

    var output: VertexOutput;
    output.position = vec4<f32>(final_pos, 0.0, 1.0);
    output.uv = uvs[vertex_index];
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // Increase samples for higher quality blur
    let num_samples = 16;
    var color_sum = vec4<f32>(0.0);
    var weight_sum = 0.0;

    // Calculate velocity magnitude for adaptive blur strength
    let velocity_mag = length(uniforms.velocity);
    let adaptive_blur = uniforms.motion_blur_amount * smoothstep(0.0, 50.0, velocity_mag);

    // Calculate blur direction from velocity
    var blur_dir = vec2<f32>(0.0);
    if (velocity_mag > 0.0) {
        blur_dir = uniforms.velocity / velocity_mag;
    }

    // Enhanced blur trail
    let max_blur_offset = 3.0 * adaptive_blur;

    for (var i = 0; i < num_samples; i++) {
        // Non-linear sampling for better blur distribution
        let t = pow(f32(i) / f32(num_samples - 1), 1.5) * 2.0 - 1.0;

        // Gaussian-like weight distribution
        let weight = exp(-3.0 * t * t);

        // Calculate sample offset with velocity-based scaling
        let offset = blur_dir * max_blur_offset * t;
        let sample_uv = input.uv + offset / uniforms.output_size.xy;

        // Sample with bilinear filtering
        let sample = textureSample(t_cursor, s_cursor, sample_uv);

        // Accumulate weighted sample
        color_sum += sample * weight;
        weight_sum += weight;
    }

    // Normalize the result
    var final_color = color_sum / weight_sum;

    // Enhance contrast slightly for fast movements
    if (velocity_mag > 30.0) {
        // Create new color with enhanced contrast instead of modifying components
        final_color = vec4<f32>(
            pow(final_color.r, 0.95),
            pow(final_color.g, 0.95),
            pow(final_color.b, 0.95),
            final_color.a
        );
    }

    return final_color;
}
