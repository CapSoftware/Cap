struct TransitionUniforms {
    progress: f32,
    kind: u32,
    opaque: u32,
    padding: u32,
};

@group(0) @binding(0) var<uniform> uniforms: TransitionUniforms;
@group(0) @binding(1) var outgoing_texture: texture_2d<f32>;
@group(0) @binding(2) var incoming_texture: texture_2d<f32>;
@group(0) @binding(3) var frame_sampler: sampler;

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
    var output: VertexOutput;
    output.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
    let uv = (positions[vertex_index] + 1.0) * 0.5;
    output.uv = vec2<f32>(uv.x, 1.0 - uv.y);
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let outgoing = textureSample(outgoing_texture, frame_sampler, input.uv);
    let incoming = textureSample(incoming_texture, frame_sampler, input.uv);
    if uniforms.kind == 0u {
        return mix(outgoing, incoming, uniforms.progress);
    }

    let outgoing_weight = max(1.0 - uniforms.progress * 2.0, 0.0);
    let incoming_weight = max(uniforms.progress * 2.0 - 1.0, 0.0);
    let black_weight = 1.0 - outgoing_weight - incoming_weight;
    let black_alpha = select(0.0, 1.0, uniforms.opaque != 0u);
    return outgoing * outgoing_weight
        + incoming * incoming_weight
        + vec4<f32>(0.0, 0.0, 0.0, black_alpha) * black_weight;
}
