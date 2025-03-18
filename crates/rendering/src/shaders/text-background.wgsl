struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) frag_position: vec3<f32>,
    @location(1) frag_color: vec4<f32>,
};

@vertex
fn vs_main(@location(0) position: vec3<f32>, @location(1) color: vec4<f32>) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4<f32>(position, 1.0);
    output.frag_position = position;
    output.frag_color = color;
    return output;
}

@fragment
fn fs_main(@location(0) frag_position: vec3<f32>, @location(1) frag_color: vec4<f32>) -> @location(0) vec4<f32> {
    return frag_color;
}
