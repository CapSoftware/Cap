struct BlurUniforms {
    direction: vec2<f32>,
    texel_size: vec2<f32>,
    intensity: f32,
    _padding: f32,
    _padding2: vec2<f32>,
};

@group(0) @binding(0) var input_tex: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: BlurUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    var uvs = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0),
    );

    var out: VertexOutput;
    out.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
    out.uv = uvs[vertex_index];
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
    let offsets = array<f32, 5>(0.0, 1.0, 2.0, 3.0, 4.0);

    let blur_scale = uniforms.intensity * 2.0;
    let step = uniforms.direction * uniforms.texel_size * blur_scale;

    var color = textureSample(input_tex, input_sampler, in.uv) * weights[0];

    for (var i = 1u; i < 5u; i = i + 1u) {
        let offset = step * offsets[i];
        color += textureSample(input_tex, input_sampler, in.uv + offset) * weights[i];
        color += textureSample(input_tex, input_sampler, in.uv - offset) * weights[i];
    }

    return color;
}
