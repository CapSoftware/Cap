struct Uniforms {
    rect_center: vec2<f32>,
    rect_size: vec2<f32>,
    feather: f32,
    opacity: f32,
    effect_size: f32,
    darkness: f32,
    mode: u32,
    padding0: u32,
    output_size: vec2<f32>,
    padding1: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var source_texture: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;

const MODE_PIXELATE: u32 = 0u;
const MODE_HIGHLIGHT: u32 = 1u;
const MODE_BLUR_HORIZONTAL: u32 = 2u;
const MODE_BLUR_VERTICAL: u32 = 3u;

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
    let px_size = max(uniforms.effect_size, 1.0);
    let cell = px_size / uniforms.output_size;
    let snapped = floor(uv / cell) * cell + cell * 0.5;
    let texture_size = textureDimensions(source_texture);
    let max_coord = vec2<i32>(texture_size) - vec2<i32>(1);
    let coord = clamp(
        vec2<i32>(snapped * vec2<f32>(texture_size)),
        vec2<i32>(0),
        max_coord,
    );
    return textureLoad(source_texture, coord, 0);
}

fn blur_sample(uv: vec2<f32>, direction: vec2<f32>) -> vec4<f32> {
    let radius = max(uniforms.effect_size, 1.0);
    let sample_step = direction * radius / (uniforms.output_size * 12.0);
    var color = vec4<f32>(0.0);
    var weight_sum = 0.0;

    for (var index = -12; index <= 12; index++) {
        let distance = f32(index) / 4.0;
        let weight = exp(-0.5 * distance * distance);
        color += textureSampleLevel(
            source_texture,
            source_sampler,
            uv + f32(index) * sample_step,
            0.0,
        ) * weight;
        weight_sum += weight;
    }

    return color / weight_sum;
}

fn horizontal_blur_support(uv: vec2<f32>) -> bool {
    let half_size = uniforms.rect_size * 0.5;
    let delta = abs(uv - uniforms.rect_center);
    let vertical_radius = uniforms.effect_size / uniforms.output_size.y;
    return delta.x <= half_size.x && delta.y <= half_size.y + vertical_radius;
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let base = textureSample(source_texture, source_sampler, uv);
    let mask = rect_mask(uv);

    if uniforms.mode == MODE_PIXELATE {
        let pixelated = pixelate_sample(uv);
        let effect = vec4<f32>(pixelated.rgb, base.a);
        return mix(base, effect, mask);
    }

    if uniforms.mode == MODE_BLUR_HORIZONTAL {
        if !horizontal_blur_support(uv) {
            return base;
        }
        let blurred = blur_sample(uv, vec2<f32>(1.0, 0.0));
        return vec4<f32>(blurred.rgb, base.a);
    }

    if uniforms.mode == MODE_BLUR_VERTICAL {
        if mask <= 0.0 {
            discard;
        }
        let blurred = blur_sample(uv, vec2<f32>(0.0, 1.0));
        return vec4<f32>(blurred.rgb, mask);
    }

    if uniforms.mode == MODE_HIGHLIGHT {
        let darkness = clamp(uniforms.darkness * uniforms.opacity, 0.0, 1.0);
        let outside = vec4<f32>(base.rgb * (1.0 - darkness), base.a);
        return mix(outside, base, mask);
    }

    return base;
}
