struct Uniforms {
    output_size: vec2<f32>,
    image_size: vec2<f32>,
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
    // Calculate scaling factors for width and height
    let scale_x = u.output_size.x / u.image_size.x;
    let scale_y = u.output_size.y / u.image_size.y;
    
    // Use the larger scale factor to ensure coverage
    let scale = max(scale_x, scale_y);
    
    // Transform coordinates to sample from the center of the scaled image
    let adjusted_coords = (tex_coords - 0.5) * (u.output_size / (u.image_size * scale)) + 0.5;
    
    return textureSample(t_image, s_image, adjusted_coords);
}
