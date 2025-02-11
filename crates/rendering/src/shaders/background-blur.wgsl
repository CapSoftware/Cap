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
    let blur_radius = u.blur_strength * 8.0;
    var color = vec4<f32>(0.0);
    var total_weight = 0.0;
    
    let samples = 15;
    let start = -(f32(samples) / 2.0);
    let end = (f32(samples) / 2.0);
    
    for (var x = 0; x < samples; x++) {
        for (var y = 0; y < samples; y++) {
            let xf = start + f32(x);
            let yf = start + f32(y);
            
            let offset = vec2<f32>(
                xf * blur_radius / u.output_size.x,
                yf * blur_radius / u.output_size.y
            );
            let sample_pos = tex_coords + offset;
            
            let distance_squared = xf * xf + yf * yf;
            let weight = exp(-distance_squared / (2.0 * u.blur_strength));
            
            color += textureSample(t_background, s_background, sample_pos) * weight;
            total_weight += weight;
        }
    }
    
    return color / total_weight;
} 