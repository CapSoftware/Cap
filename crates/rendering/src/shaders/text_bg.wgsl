struct BackgroundUniforms {
    rect: vec4<f32>,
    color: vec4<f32>,
    radius: f32,
    _padding0: f32,
    _padding1: f32,
    _padding2: f32,
    output_size: vec2<f32>,
    _padding3: vec2<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: BackgroundUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0),
    );

    let fringe = 2.0;
    let expanded_min = uniforms.rect.xy - vec2<f32>(fringe);
    let expanded_size = uniforms.rect.zw + vec2<f32>(fringe * 2.0);
    let pixel = expanded_min + positions[vertex_index] * expanded_size;
    var output: VertexOutput;
    output.position = vec4<f32>(
        pixel.x / uniforms.output_size.x * 2.0 - 1.0,
        1.0 - pixel.y / uniforms.output_size.y * 2.0,
        0.0,
        1.0,
    );
    return output;
}

fn rounded_rect_sdf(p: vec2<f32>, half_size: vec2<f32>, radius: f32) -> f32 {
    let q = abs(p) - half_size + vec2<f32>(radius);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let rect_min = uniforms.rect.xy;
    let rect_size = uniforms.rect.zw;
    let rect_center = rect_min + rect_size * 0.5;
    let half_size = rect_size * 0.5;
    let distance = rounded_rect_sdf(position.xy - rect_center, half_size, uniforms.radius);
    let alpha = 1.0 - smoothstep(-1.5, 1.5, distance);

    return vec4<f32>(uniforms.color.rgb, uniforms.color.a * alpha);
}
