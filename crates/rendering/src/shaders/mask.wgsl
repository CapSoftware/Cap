struct Uniforms {
    rect_center: vec2<f32>,
    rect_size: vec2<f32>,
    feather: f32,
    opacity: f32,
    pixel_size: f32,
    darkness: f32,
    mode: u32,
    padding0: u32,
    output_size: vec2<f32>,
    padding1: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var source_texture: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );

    let pos = positions[vertex_index];
    var out: VertexOutput;
    out.position = vec4<f32>(pos, 0.0, 1.0);
    out.uv = vec2<f32>(pos.x * 0.5 + 0.5, 1.0 - (pos.y * 0.5 + 0.5));
    return out;
}

fn rect_mask(uv: vec2<f32>) -> f32 {
    let half_size = uniforms.rect_size * 0.5;
    let delta = abs(uv - uniforms.rect_center) - half_size;
    let outside = max(delta, vec2<f32>(0.0));
    let outside_dist = length(outside);
    let inside_dist = min(max(delta.x, delta.y), 0.0);
    let sdf = outside_dist + inside_dist;
    let edge = max(uniforms.feather, 1e-4);
    return clamp(smoothstep(0.0, edge, -sdf), 0.0, 1.0);
}

fn pixelate_sample(uv: vec2<f32>) -> vec4<f32> {
    let px_size = max(uniforms.pixel_size, 1.0);
    let cell = px_size / uniforms.output_size;
    let snapped = floor(uv / cell) * cell + cell * 0.5;
    return textureSample(source_texture, source_sampler, snapped);
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let base = textureSample(source_texture, source_sampler, uv);
    let mask = rect_mask(uv);

    if uniforms.mode == 0u {
        let pixelated = pixelate_sample(uv);
        let mix_amount = clamp(uniforms.opacity, 0.0, 1.0);
        let effect = mix(base, pixelated, mix_amount);
        return mix(base, effect, mask * mix_amount);
    }

    let darkness = clamp(uniforms.darkness * uniforms.opacity, 0.0, 1.0);
    let outside = vec4<f32>(base.rgb * (1.0 - darkness), base.a);
    return mix(outside, base, mask);
}
