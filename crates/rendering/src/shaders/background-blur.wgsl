// Background blur: separable gaussian, run twice (horizontal then vertical).
//
// The kernel always spans the full blur radius with evenly spaced taps; when
// the radius exceeds the tap budget the spacing widens instead of leaving
// gaps, and linear filtering interpolates between texels. Spacing stays well
// under sigma, so the widened kernel cannot alias into the comb/grid pattern
// the old single-pass sparse kernel produced.

struct Uniforms {
    output_size: vec2<f32>,
    blur_strength: f32,
    direction: f32, // 0 = horizontal, 1 = vertical
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var t_background: texture_2d<f32>;
@group(0) @binding(2) var s_background: sampler;

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

@fragment
fn fs_main(@location(0) tex_coords: vec2<f32>) -> @location(0) vec4<f32> {
    if (u.blur_strength <= 0.001) {
        return textureSampleLevel(t_background, s_background, tex_coords, 0.0);
    }

    // Sigma scales with output height so preview and export look identical;
    // full strength blurs with a sigma of 2.5% of the frame height.
    let sigma = u.blur_strength * u.output_size.y * 0.025;
    let radius = sigma * 3.0;
    let taps = min(24.0, ceil(radius));
    let spacing = radius / taps;

    var step = vec2<f32>(spacing / u.output_size.x, 0.0);
    if (u.direction > 0.5) {
        step = vec2<f32>(0.0, spacing / u.output_size.y);
    }

    var color = textureSampleLevel(t_background, s_background, tex_coords, 0.0);
    var total_weight = 1.0;
    let inv_sigma2 = 1.0 / (2.0 * sigma * sigma);
    let n = i32(taps);

    for (var i = 1; i <= n; i++) {
        let dist = f32(i) * spacing;
        let weight = exp(-dist * dist * inv_sigma2);
        let offset = step * f32(i);
        color += textureSampleLevel(t_background, s_background, tex_coords + offset, 0.0) * weight;
        color += textureSampleLevel(t_background, s_background, tex_coords - offset, 0.0) * weight;
        total_weight += 2.0 * weight;
    }

    return color / total_weight;
}
