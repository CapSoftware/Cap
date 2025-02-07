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
    
    // Calculate aspect ratios
    let container_ratio = u.output_size.x / u.output_size.y;
    let texture_dims = vec2<f32>(textureDimensions(t_image));
    let texture_ratio = texture_dims.x / texture_dims.y;
    
    // Calculate scale factors to achieve 'cover' behavior
    var scale = vec2<f32>(1.0);
    if (container_ratio > texture_ratio) {
        // Container is wider than texture - scale based on height
        scale.x = texture_ratio / container_ratio;
        scale.y = 1.0;
    } else {
        // Container is taller than texture - scale based on width
        scale.x = 1.0;
        scale.y = container_ratio / texture_ratio;
    }
    
    // Transform coordinates to center and scale the image
    let transformed_coords = (adjusted_coords - 0.5) * scale + 0.5;
    
    // Let the sampler handle the edge clamping
    return textureSample(t_image, s_image, transformed_coords);
}