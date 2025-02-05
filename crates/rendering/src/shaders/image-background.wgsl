struct Uniforms {
    output_size: vec2<f32>,
    padding: f32,
    _padding: f32,  // Matches the Rust struct alignment padding
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var t_image: texture_2d<f32>;
@group(0) @binding(2) var s_image: sampler;

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(i32(in_vertex_index & 1u) * 4 - 1);
    let y = f32(i32(in_vertex_index & 2u) * 2 - 1);
    out.tex_coords = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
    out.clip_position = vec4<f32>(x, y, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(@location(0) tex_coords: vec2<f32>) -> @location(0) vec4<f32> {
    // Calculate the padding in UV space
    let padding_uv = u.padding / max(u.output_size.x, u.output_size.y);
    
    // Adjust UV coordinates to account for padding
    let adjusted_coords = tex_coords * (1.0 - 2.0 * padding_uv) + padding_uv;
    
    // Sample the texture with the adjusted coordinates
    let color = textureSample(t_image, s_image, adjusted_coords);
    
    // If the adjusted coordinates are outside the [0,1] range, return transparent
    let is_inside = all(adjusted_coords >= vec2<f32>(0.0)) && 
                    all(adjusted_coords <= vec2<f32>(1.0));
    
    return select(vec4<f32>(0.0), color, is_inside);
}
