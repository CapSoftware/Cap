struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct Uniforms {
    position_size: vec4<f32>,
    output_size: vec4<f32>,
    screen_bounds: vec4<f32>,
    velocity_blur_opacity: vec4<f32>,
    shadow_params: vec4<f32>,
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
    let num_samples: u32 = 24u;

    let velocity = uniforms.velocity_blur_opacity.xy;
    let motion_blur_amount = uniforms.velocity_blur_opacity.z;
    let opacity = uniforms.velocity_blur_opacity.w;

    let base_sample = textureSample(t_cursor, s_cursor, input.uv);
    let velocity_mag = length(velocity);

    let cursor_size = max(uniforms.position_size.zw, vec2<f32>(1.0, 1.0));
    let pixel_to_uv = vec2<f32>(1.0, 1.0) / cursor_size;

    var shadow_motion_shift: vec2<f32> = vec2<f32>(0.0);
    var motion_shadow_alpha = 0.0;

    var final_color = base_sample;

    if (velocity_mag > 1e-4 && motion_blur_amount > 0.0) {
        let direction = velocity / velocity_mag;
        let adaptive_blur = motion_blur_amount * smoothstep(0.0, 20.0, velocity_mag);
        let blur_strength = clamp(adaptive_blur, 0.0, 1.0);
        let blur_extent = clamp(
            velocity_mag * mix(0.35, 1.6, blur_strength) + motion_blur_amount * 8.0,
            0.0,
            96.0
        );

        let base_weight = mix(1.0, 0.18, blur_strength);
        var blur_sum = base_sample * base_weight;
        var weight_sum = base_weight;

        for (var i: u32 = 1u; i <= num_samples; i = i + 1u) {
            let t = f32(i) / f32(num_samples);
            let falloff = pow(1.0 - t, 1.6);
            let offset = direction * (blur_extent * t);
            let sample_uv = input.uv - offset * pixel_to_uv;
            if (sample_uv.x >= 0.0 && sample_uv.x <= 1.0 && sample_uv.y >= 0.0 && sample_uv.y <= 1.0) {
                let weight = mix(1.0, 0.12, t) * falloff;
                let sample = textureSample(t_cursor, s_cursor, sample_uv);
                blur_sum += sample * weight;
                weight_sum += weight;
            }
        }

        if (weight_sum > 0.0) {
            let blurred = blur_sum / weight_sum;
            let tail_mix = clamp(blur_strength * 1.25, 0.0, 1.0);
            let final_rgb = mix(base_sample.rgb, blurred.rgb, tail_mix);
            let final_alpha = mix(base_sample.a, max(base_sample.a, blurred.a), tail_mix);
            final_color = vec4<f32>(final_rgb, final_alpha);

            shadow_motion_shift = direction * (blur_extent * 0.4 * tail_mix) * pixel_to_uv;
            motion_shadow_alpha = clamp(blurred.a * tail_mix, 0.0, 1.0);

            if (velocity_mag > 30.0) {
                final_color = vec4<f32>(
                    pow(final_color.r, 0.95),
                    pow(final_color.g, 0.95),
                    pow(final_color.b, 0.95),
                    final_color.a
                );
            }
        }
    }

    final_color *= opacity;

    // Enhance contrast slightly for fast movements
    if (velocity_mag > 30.0) {
        final_color = vec4<f32>(
            pow(final_color.r, 0.95),
            pow(final_color.g, 0.95),
            pow(final_color.b, 0.95),
            final_color.a
        );
    }

    final_color *= opacity;

    // Sample slightly offset silhouettes to build a soft drop shadow behind the cursor.
    let shadow_offsets = array<vec2<f32>, 4>(
        vec2<f32>(0.4, 1.8),
        vec2<f32>(0.9, 2.4),
        vec2<f32>(0.3, 2.9),
        vec2<f32>(0.8, 3.4)
    );

    let shadow_sample_count: u32 = 4u;
    let shadow_size = max(uniforms.shadow_params.x, 0.0);
    let shadow_blur = clamp(uniforms.shadow_params.y, 0.0, 1.0);
    let shadow_opacity = clamp(uniforms.shadow_params.z, 0.0, 1.0);

    let blur_spread = 1.0 + shadow_blur * 1.6;

    var max_shadow_alpha = 0.0;
    var shadow_sum = 0.0;
    for (var i: u32 = 0u; i < shadow_sample_count; i = i + 1u) {
        let offset = shadow_offsets[i] * shadow_size * blur_spread;
        let sample_uv = clamp(
            input.uv - offset * pixel_to_uv - shadow_motion_shift,
            vec2<f32>(0.0),
            vec2<f32>(1.0)
        );
        let sample_alpha = textureSample(t_cursor, s_cursor, sample_uv).a;
        max_shadow_alpha = max(max_shadow_alpha, sample_alpha);
        shadow_sum += sample_alpha;
    }

    let average_shadow = shadow_sum / f32(shadow_sample_count);
    let softened_shadow = mix(max_shadow_alpha, average_shadow, shadow_blur);

    let base_shadow_alpha = softened_shadow * shadow_opacity * opacity;
    let motion_shadow = motion_shadow_alpha * shadow_opacity * opacity;
    let shadow_alpha = clamp(max(base_shadow_alpha, motion_shadow), 0.0, 1.0);
    let combined_alpha = clamp(final_color.a + shadow_alpha * (1.0 - final_color.a), 0.0, 1.0);

    return vec4<f32>(final_color.rgb, combined_alpha);
}
