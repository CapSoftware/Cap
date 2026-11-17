struct TransitionUniforms {
    progress: f32,
    kind: u32,
    opaque: u32,
    padding: u32,
    outgoing: vec4<f32>,
    incoming: vec4<f32>,
    wipe: vec4<f32>,
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
    let dip = select(0.0, black_alpha, uniforms.kind == 2u);
    return outgoing * outgoing_weight
        + incoming * incoming_weight
        + vec4<f32>(dip, dip, dip, black_alpha) * black_weight;
}

fn sample_layer(texture: texture_2d<f32>, uv: vec2<f32>, layer: vec4<f32>) -> vec4<f32> {
    let scale = max(layer.z, 0.0001);
    let source = (uv - vec2<f32>(0.5) - layer.xy) / scale + vec2<f32>(0.5);
    let size = vec2<f32>(textureDimensions(texture));
    let inside = min(
        min(source.x, 1.0 - source.x) * size.x,
        min(source.y, 1.0 - source.y) * size.y,
    ) * scale;
    let coverage = clamp(inside + 0.5, 0.0, 1.0);
    let color = textureSampleLevel(texture, frame_sampler, clamp(source, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0);
    return color * (coverage * clamp(layer.w, 0.0, 1.0));
}

@fragment
fn fs_layers(input: VertexOutput) -> @location(0) vec4<f32> {
    let outgoing = sample_layer(outgoing_texture, input.uv, uniforms.outgoing);
    let incoming = sample_layer(incoming_texture, input.uv, uniforms.incoming);
    var incoming_share = 1.0;
    var outgoing_share = 1.0;
    if uniforms.wipe.w > 0.0 {
        let direction = uniforms.wipe.xy;
        let along_x = select(input.uv.x * direction.x, (1.0 - input.uv.x) * -direction.x, direction.x < 0.0);
        let along_y = select(input.uv.y * direction.y, (1.0 - input.uv.y) * -direction.y, direction.y < 0.0);
        let t = clamp((uniforms.wipe.z - (along_x + along_y)) / uniforms.wipe.w, 0.0, 1.0);
        incoming_share = t * t * (3.0 - 2.0 * t);
        outgoing_share = 1.0 - incoming_share;
    }
    return min(outgoing * outgoing_share + incoming * incoming_share, vec4<f32>(1.0));
}
