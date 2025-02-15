struct Uniforms {
    output_size: vec2<f32>,
    blur_strength: f32,
    _padding: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var t_background: texture_2d<f32>;
@group(0) @binding(2) var s_background: sampler;

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
    // Early return if no blur
    if (u.blur_strength <= 0.01) {
        return textureSample(t_background, s_background, tex_coords);
    }

    // Use smaller kernel for light blur
    let radius = u.blur_strength * 16.0;
    let sigma = radius * 0.5;
    let samples = min(16, max(4, i32(radius * 0.3)));
    
    var color = vec4<f32>(0.0);
    var total_weight = 0.0;
    
    for (var y = -samples; y <= samples; y++) {
        for (var x = -samples; x <= samples; x++) {
            let offset = vec2<f32>(
                f32(x) * radius / u.output_size.x,
                f32(y) * radius / u.output_size.y
            );
            
            let sample_pos = tex_coords + offset;
            let dist = f32(x * x + y * y);
            let weight = exp(-dist / (2.0 * sigma * sigma));
            
            color += textureSample(t_background, s_background, sample_pos) * weight;
            total_weight += weight;
        }
    }
    
    return color / total_weight;
} 