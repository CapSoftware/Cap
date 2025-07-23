struct StateUniforms {
    shape: f32,
    size: f32,
    mirrored: f32,
    _padding: f32,
}

struct WindowUniforms {
    window_height: f32,
    window_width: f32,
    toolbar_percentage: f32,
    _padding: f32,
}

struct CameraUniforms {
    camera_aspect_ratio: f32,
    _padding: f32,
}

@group(1) @binding(0)
var<uniform> uniforms: StateUniforms;

@group(1) @binding(1)
var<uniform> window_uniforms: WindowUniforms;

@group(1) @binding(2)
var<uniform> camera_uniforms: CameraUniforms;

@group(0) @binding(0)
var t_camera: texture_2d<f32>;

@group(0) @binding(1)
var s_camera: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    // @location(0) tex_coords: vec2<f32>,
};

// @vertex
// fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
//     var out: VertexOutput;
//     let x = f32(i32(in_vertex_index & 1u) * 4 - 1);
//     let y = f32(i32(in_vertex_index & 2u) * 2 - 1);

//     // Map y from [-1, 1] to [-1, 1-toolbar_percentage*2] to align to bottom
//     let toolbar_clip_offset = window_uniforms.toolbar_percentage * 2.0;
//     let y_offset = mix(-1.0, 1.0 - toolbar_clip_offset, (y * 0.5 + 0.5));
//     out.clip_position = vec4<f32>(x, y_offset, 0.0, 1.0);

//     // Map tex_coords.y from [0, 1] to [toolbar_percentage, 1] to skip toolbar area
//     let u = x * 0.5 + 0.5;
//     let v = mix(window_uniforms.toolbar_percentage, 1.0, 1.0 - (y * 0.5 + 0.5));
//     out.tex_coords = vec2<f32>(u, v);
//     return out;
// }

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    var pos: vec2<f32>;

    // We use the vertex_index to determine the position of each vertex.
    // This maps the 6 vertex indices to NDC coordinates for a fullscreen quad.
    switch in_vertex_index {
        case 0u: { // First triangle (bottom-left)
            pos = vec2<f32>(-1.0, -1.0);
        }
        case 1u: {
            pos = vec2<f32>(1.0, -1.0);
        }
        case 2u: {
            pos = vec2<f32>(-1.0, 1.0);
        }
        case 3u: { // Second triangle (top-right)
            pos = vec2<f32>(-1.0, 1.0); // Duplicate of case 2
        }
        case 4u: {
            pos = vec2<f32>(1.0, -1.0); // Duplicate of case 1
        }
        case 5u: {
            pos = vec2<f32>(1.0, 1.0);
        }
        default: { // Should not happen for a draw call with 6 vertices
            pos = vec2<f32>(0.0, 0.0);
        }
    }

    pos.y *= (1.0 - window_uniforms.toolbar_percentage);
    pos.y -= window_uniforms.toolbar_percentage;

    // pos.y += 1;
    // pos.y /= 2;
    // pos.y *= (1.0 - window_uniforms.toolbar_percentage);
    // // pos.y -= window_uniforms.toolbar_percentage / 2;
    // pos.y *= 2;
    // pos.y -= 1;

    out.position = vec4<f32>(pos, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(255.0, 0.0, 0.0, 255.0);
}
