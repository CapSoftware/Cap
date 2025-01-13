struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct Uniforms {
    output_size: vec2<f32>,
    watermark_size: vec2<f32>,
    position: vec2<f32>,
    opacity: f32,
    is_upgraded: f32,
};

@group(0) @binding(0) var watermark_texture: texture_2d<f32>;
@group(0) @binding(1) var watermark_sampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    
    // Define vertices for two triangles forming a quad
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),  // First triangle
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0),  // Second triangle
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0)
    );
    
    let uv = positions[vertex_index];
    
    // Calculate position in screen space
    let size = uniforms.watermark_size;
    let pos = uniforms.position;
    let screen_pos = pos + (uv * size);
    
    // Convert to clip space (-1 to 1)
    let clip_pos = (screen_pos / uniforms.output_size) * 2.0 - 1.0;
    out.position = vec4<f32>(clip_pos.x, -clip_pos.y, 0.0, 1.0);
    out.uv = uv;
    
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(watermark_texture, watermark_sampler, in.uv);
    // Ensure the watermark is visible by using premultiplied alpha
    let alpha = color.a * uniforms.opacity;
    return vec4<f32>(color.rgb * alpha, alpha);
} 