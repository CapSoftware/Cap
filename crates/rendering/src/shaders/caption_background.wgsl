struct Uniforms {
    position: vec2<f32>,      // Center position in pixels
    size: vec2<f32>,          // Width and height in pixels
    color: vec4<f32>,         // RGBA color
    corner_radius: f32,       // Corner radius in pixels
    viewport_size: vec2<f32>, // Viewport dimensions
    _padding1: f32,
    _padding2: vec4<f32>,     // Padding for alignment
}

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

struct VertexInput {
    @location(0) position: vec2<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    
    // Scale the quad to the desired size
    let scaled_pos = input.position * uniforms.size * 0.5;
    
    // Add the center position offset
    let world_pos = scaled_pos + uniforms.position;
    
    // Convert to clip space (-1 to 1)
    let clip_pos = vec2<f32>(
        (world_pos.x / uniforms.viewport_size.x) * 2.0 - 1.0,
        1.0 - (world_pos.y / uniforms.viewport_size.y) * 2.0
    );
    
    output.position = vec4<f32>(clip_pos, 0.0, 1.0);
    output.uv = input.position; // Pass through the UV coordinates (-1 to 1)
    
    return output;
}

// Signed distance function for a rounded rectangle
fn sdRoundedRect(p: vec2<f32>, size: vec2<f32>, radius: f32) -> f32 {
    let half_size = size * 0.5;
    let q = abs(p) - half_size + radius;
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // Convert UV from -1 to 1 to actual pixel coordinates relative to center
    let local_pos = input.uv * uniforms.size * 0.5;
    
    // Calculate signed distance to the rounded rectangle
    let dist = sdRoundedRect(local_pos, uniforms.size, uniforms.corner_radius);
    
    // Smooth edge (anti-aliasing)
    let edge_softness = 1.0;
    let alpha = 1.0 - smoothstep(-edge_softness, edge_softness, dist);
    
    // Apply alpha to the color
    return vec4<f32>(uniforms.color.rgb, uniforms.color.a * alpha);
}