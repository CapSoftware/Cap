struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct Uniforms {
    position: vec2<f32>,
    size: vec2<f32>,
    output_size: vec4<f32>,
    screen_bounds: vec4<f32>,
    velocity: vec2<f32>,
    motion_blur_amount: f32,
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
    let screen_pos = uniforms.position.xy;

    // Calculate final position - centered around cursor position
    // Flip the Y coordinate by subtracting from output height
    var adjusted_pos = screen_pos;
    adjusted_pos.y = uniforms.output_size.y - adjusted_pos.y;  // Flip Y coordinate

    let final_pos = ((pos * uniforms.size) + adjusted_pos) / uniforms.output_size.xy * 2.0 - 1.0;

    var output: VertexOutput;
    output.position = vec4<f32>(final_pos, 0.0, 1.0);
    output.uv = uvs[vertex_index];
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // Base texture lookup for static case
    let base_texture = textureSample(t_cursor, s_cursor, input.uv);
    
    // Calculate velocity magnitude for adaptive blur strength
    let velocity_mag = length(uniforms.velocity);
    
    // Apply blur even at very low motion_blur_amount values, but skip if truly zero
    if (uniforms.motion_blur_amount <= 0.0) {
        return base_texture;
    }
    
    // Increase samples for higher quality blur
    let num_samples = 32; // Increased for smoother blur
    var color_sum = vec4<f32>(0.0);
    var weight_sum = 0.0;

    // Make blur responsive to even small velocity values
    // Scale blur amount by velocity but ensure even slow movements have some blur
    let min_blur = uniforms.motion_blur_amount * 0.05; // Minimum blur amount
    let velocity_factor = smoothstep(0.0, 40.0, velocity_mag); // Wider range for smoother transitions
    let adaptive_blur = min_blur + (uniforms.motion_blur_amount * velocity_factor * 0.95);

    // Calculate blur direction from velocity
    // Use actual velocity direction but normalize magnitude for consistent behavior
    var blur_dir = normalize(uniforms.velocity) * min(velocity_mag, 60.0);

    // Enhanced blur trail with smoother gradient
    let max_blur_offset = 8.0 * adaptive_blur;

    for (var i = 0; i < num_samples; i++) {
        // Non-linear sampling for better blur distribution
        // Use a more gradual power curve for smoother transitions
        let t = pow(f32(i) / f32(num_samples), 1.0);

        // Calculate sample offset with velocity-based scaling
        let offset = blur_dir * max_blur_offset * t;
        let sample_uv = input.uv - offset / uniforms.output_size.xy;

        // Sample with bilinear filtering
        let sample = textureSample(t_cursor, s_cursor, sample_uv);

        // Apply weight based on sample position in the trail
        // Use a more gradual falloff for smoother blending
        let weight = 1.0 - (0.5 * t);
        color_sum += sample * weight;
        weight_sum += weight;
    }

    // Normalize the result
    var final_color = color_sum / weight_sum;

    // Enhance contrast slightly for fast movements with lower threshold
    if (velocity_mag > 10.0) {
        // Create new color with enhanced contrast
        final_color = vec4<f32>(
            pow(final_color.r, 0.9),
            pow(final_color.g, 0.9),
            pow(final_color.b, 0.9),
            final_color.a
        );
    }

    // Less opacity reduction to maintain cursor visibility
    return final_color * vec4<f32>(1.0, 1.0, 1.0, 1.0 - uniforms.motion_blur_amount * 0.05);
}
