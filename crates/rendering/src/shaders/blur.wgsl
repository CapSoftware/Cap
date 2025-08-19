struct BlurSegment {
    rect: vec4<f32>, // [x, y, width, height]
    blur_amount: f32,
    @align(16) _padding: vec3<f32>,
}

struct Uniforms {
    output_size: vec2<f32>,
    blur_segments_count: u32,
    @align(16) _padding: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var t_input: texture_2d<f32>;
@group(0) @binding(2) var s_input: sampler;
@group(0) @binding(3) var<storage, read> blur_segments: array<BlurSegment>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    let uv = vec2<f32>(
        f32(vertex_index & 1u),
        f32((vertex_index >> 1u) & 1u)
    );
    let pos = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
    return VertexOutput(pos, uv);
}

fn apply_blur(uv: vec2<f32>, blur_amount: f32) -> vec4<f32> {
    let pixel_size = 1.0 / uniforms.output_size;
    var color = vec4<f32>(0.0);
    var total_weight = 0.0;
    let radius = i32(ceil(blur_amount));

    for (var x = -2; x <= 2; x = x + 1) {
        for (var y = -2; y <= 2; y = y + 1) {
            let offset = vec2<f32>(f32(x), f32(y)) * pixel_size * blur_amount / 2.0;
            let weight = exp(-f32(x * x + y * y) / (2.0 * blur_amount * blur_amount));
            color = color + textureSample(t_input, s_input, uv + offset) * weight;
            total_weight = total_weight + weight;
        }
    }
    return color / total_weight;
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let debug_mode = false;
    for (var i: u32 = 0u; i < uniforms.blur_segments_count; i = i + 1u) {
        let segment = blur_segments[i];
        if (uv.x >= segment.rect.x && uv.x <= segment.rect.x + segment.rect.z &&
            uv.y >= segment.rect.y && uv.y <= segment.rect.y + segment.rect.w) {
            if (debug_mode) {
                return vec4<f32>(1.0, 0.0, 0.0, 1.0);
            }
            return apply_blur(uv, segment.blur_amount);
        }
    }
    return textureSample(t_input, s_input, uv);
}