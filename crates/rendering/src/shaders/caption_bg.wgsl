struct BackgroundUniforms {
    rect: vec4<f32>,
    color: vec4<f32>,
    radius: f32,
    _padding: vec3<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: BackgroundUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(1.0, 1.0),
    );

    var output: VertexOutput;
    output.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
    return output;
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let rect_min = uniforms.rect.xy;
    let rect_size = uniforms.rect.zw;
    let rect_center = rect_min + rect_size * 0.5;
    let radius = uniforms.radius;
    let half_size = rect_size * 0.5;

    let local = position.xy - rect_center;
    let dist = abs(local) - (half_size - vec2<f32>(radius, radius));
    let outside = max(dist, vec2<f32>(0.0, 0.0));
    let distance = length(outside) - radius;
    let alpha = clamp(1.0 - distance, 0.0, 1.0);

    return vec4<f32>(uniforms.color.rgb, uniforms.color.a * alpha);
}
