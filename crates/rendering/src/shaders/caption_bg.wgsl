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

fn squircle_sdf(p: vec2<f32>, half_size: vec2<f32>, radius: f32) -> f32 {
    let adjusted_half = half_size - vec2<f32>(radius);
    let q = abs(p) - adjusted_half;
    
    if q.x <= 0.0 && q.y <= 0.0 {
        return max(q.x, q.y) - radius;
    }
    
    let corner = max(q, vec2<f32>(0.0));
    let n = 4.0;
    let corner_dist = pow(pow(corner.x, n) + pow(corner.y, n), 1.0 / n);
    
    return corner_dist - radius;
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let rect_min = uniforms.rect.xy;
    let rect_size = uniforms.rect.zw;
    let rect_center = rect_min + rect_size * 0.5;
    let radius = uniforms.radius;
    let half_size = rect_size * 0.5;

    let local = position.xy - rect_center;
    let distance = squircle_sdf(local, half_size, radius);
    
    let edge_softness = 1.5;
    let alpha = 1.0 - smoothstep(-edge_softness, edge_softness, distance);

    return vec4<f32>(uniforms.color.rgb, uniforms.color.a * alpha);
}
