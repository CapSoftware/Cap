struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct Uniforms {
    position: vec4<f32>,
    size: vec4<f32>,
    output_size: vec4<f32>,
    screen_bounds: vec4<f32>,
    cursor_size: f32,
    last_click_time: f32,
    padding: vec2<f32>,
    _alignment: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

@group(0) @binding(1)
var t_cursor: texture_2d<f32>;

@group(0) @binding(2)
var s_cursor: sampler;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 4>(
        vec2<f32>(-0.5, 0.5),
        vec2<f32>(-0.5, -0.5),
        vec2<f32>(0.5, 0.5),
        vec2<f32>(0.5, -0.5)
    );

    var uvs = array<vec2<f32>, 4>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0)
    );

    let pos = positions[vertex_index];
    let size = uniforms.size.xy;
    let screen_pos = uniforms.position.xy;
    
    // Calculate click animation scale factor
    let time_since_click = uniforms.last_click_time;
    let click_scale = 1.0 - (0.2 * smoothstep(0.0, 0.25, time_since_click) * (1.0 - smoothstep(0.25, 0.5, time_since_click)));
    
    // Apply cursor size scaling with click animation
    let scaled_size = size * uniforms.cursor_size * click_scale;
    
    // Calculate final position - centered around cursor position
    // Flip the Y coordinate by subtracting from output height
    var adjusted_pos = screen_pos;
    adjusted_pos.y = uniforms.output_size.y - adjusted_pos.y;  // Flip Y coordinate
    
    let final_pos = ((pos * scaled_size) + adjusted_pos) / uniforms.output_size.xy * 2.0 - 1.0;

    var output: VertexOutput;
    output.position = vec4<f32>(final_pos, 0.0, 1.0);
    output.uv = uvs[vertex_index];
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(t_cursor, s_cursor, input.uv);
}
