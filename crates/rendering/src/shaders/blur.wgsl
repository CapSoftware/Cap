/**
 * @struct BlurSegment
 * Defines the data structure for a single blur region.
 */
struct BlurSegment {
    rect: vec4<f32>,
    blur_amount: f32,
    _padding1: f32,
    _padding2: f32,
    _padding3: f32,
};

/**
 * @struct Uniforms
 * Defines global settings for the shader pass.
 */
struct Uniforms {
    output_size: vec2<f32>,
    blur_segments_count: u32,
    _padding: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var t_input: texture_2d<f32>;
@group(0) @binding(2) var s_input: sampler;
@group(0) @binding(3) var<storage, read> blur_segments: array<BlurSegment>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    // Generate a full-screen triangle with consistent UV mapping
    // (0,0) = top-left, (1,1) = bottom-right (matches frontend)
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0), // Bottom-left in clip space
        vec2<f32>( 3.0, -1.0), // Far bottom-right in clip space
        vec2<f32>(-1.0,  3.0)  // Far top-left in clip space
    );
    
    // Fixed UV coordinates - consistent mapping
    var uvs = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0), // Bottom-left in texture space
        vec2<f32>(2.0, 1.0), // Far bottom-right in texture space
        vec2<f32>(0.0, -1.0) // Far top-left in texture space
    );
    
    let pos = positions[vertex_index];
    let uv = uvs[vertex_index];
    
    return VertexOutput(vec4<f32>(pos, 0.0, 1.0), uv);
}

/**
 * @function apply_blur
 * Performs Gaussian blur with proper sampling
 */
fn apply_blur(uv: vec2<f32>, blur_amount: f32) -> vec4<f32> {
    let pixel_size = 1.0 / uniforms.output_size;
    var color = vec4<f32>(0.0);
    var total_weight = 0.0;
    
    // Reduced kernel size for better performance
    let radius = i32(blur_amount * 8.0); // Dynamic radius based on blur amount
    let max_radius = min(radius, 25); // Cap at 25 to prevent excessive samples
    let sigma = f32(max_radius) / 2.5;

    for (var y = -max_radius; y <= max_radius; y = y + 1) {
        for (var x = -max_radius; x <= max_radius; x = x + 1) {
            let offset = vec2<f32>(f32(x), f32(y)) * pixel_size;
            let sample_pos = uv + offset;
            
            // Sample from anywhere in the texture, not restricted to rectangle
            // This allows blur to sample from outside the blur region
            let sample_uv = clamp(sample_pos, vec2<f32>(0.0), vec2<f32>(1.0));
            
            let dist_sq = f32(x * x + y * y);
            let weight = exp(-dist_sq / (2.0 * sigma * sigma));
            
            color += textureSample(t_input, s_input, sample_uv) * weight;
            total_weight += weight;
        }
    }

    return color / max(total_weight, 0.001);
}

@fragment
fn fs_main(frag_in: VertexOutput) -> @location(0) vec4<f32> {
    // Check if current pixel is inside any blur rectangle
    for (var i: u32 = 0u; i < uniforms.blur_segments_count; i = i + 1u) {
        let segment = blur_segments[i];
        let rect = segment.rect;

        // Check if pixel is inside the blur rectangle
        if (frag_in.uv.x >= rect.x && frag_in.uv.x <= rect.x + rect.z &&
            frag_in.uv.y >= rect.y && frag_in.uv.y <= rect.y + rect.w) {
            
            // Apply blur - sample from entire texture, not just rectangle
            return apply_blur(frag_in.uv, segment.blur_amount);
        }
    }

    // If pixel is not in any blur rectangle, return original color
    return textureSample(t_input, s_input, frag_in.uv);
}