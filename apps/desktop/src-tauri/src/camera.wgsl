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

struct VertexOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

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
uv;

    // Apply cover behavior based on aspect ratio
    let window_aspect = window_uniforms.window_width / window_uniforms.window_height;

    if (camera_uniforms.camera_aspect_ratio > window_aspect) {
        // Camera wider than window - scale horizontally
        let scale = window_aspect / camera_uniforms.camera_aspect_ratio;
        uv.x = uv.x * scale + (1.0 - scale) * 0.5;
    } else {
        // Camera taller than window - scale vertically, align to bottom
        let scale = camera_uniforms.camera_aspect_ratio / window_aspect;
        uv.y = uv.y * scale + (1.0 - scale);
    }

    // Apply mirroring if enabled
    if (uniforms.mirrored == 1.0) {
        uv.x = 1.0 - uv.x;
    }

    return uv;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    // Check if we're in the toolbar area (top portion of window)
    if (in.uv.y < window_uniforms.toolbar_percentage) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0); // Transparent toolbar area
    }

    // Get camera UV coordinates
    let camera_uv = get_camera_uv(in.uv);

    // Convert to centered coordinates [-1, 1]
    let center_uv = (in.uv - 0.5) * 2.0;

    // Shape constants: 0 = Round, 1 = Square, 2 = Full
    let shape = uniforms.shape;
    let size = uniforms.size;
    let corner_radius = select(0.08, 0.1, size == 1.0);

    var mask = 1.0;

    // Apply shape-specific masking
    if (shape == 0.0) {
        // Round shape - circular mask
        let aspect_ratio = window_uniforms.window_width / window_uniforms.window_height;
        let toolbar_offset = window_uniforms.toolbar_percentage * 2.0;
        let circle_center_y = -toolbar_offset;
        let scaled_uv = vec2<f32>(center_uv.x * aspect_ratio, center_uv.y - circle_center_y);
        mask = select(0.0, 1.0, length(scaled_uv) <= 1.0);
    } else if (shape == 1.0) {
        // Square shape - rounded corners with toolbar offset
        let toolbar_offset = window_uniforms.toolbar_percentage * 2.0;
        let shifted_uv = center_uv - vec2<f32>(0.0, -toolbar_offset);
        mask = apply_rounded_corners(shifted_uv, select(0.1, 0.12, size == 1.0));
    } else if (shape == 2.0) {
        // Full shape - rounded corners
        mask = apply_rounded_corners(center_uv, corner_radius);
    }

    // Apply mask and sample camera
    if (mask < 0.5) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    let camera_color = textureSample(t_camera, s_camera, camera_uv);
    return vec4<f32>(camera_color.rgb, 1.0);
}
