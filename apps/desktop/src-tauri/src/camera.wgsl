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
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
    var out: VertexOutput;

    // We use the vertex_index to determine the position of each vertex.
    // This maps the 6 vertex indices to NDC coordinates for a fullscreen quad.
    var indexes = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),// First triangle (bottom-left)
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0), // Second triangle (top-right)
        vec2<f32>(1.0, -1.0),
        vec2<f32>(1.0, 1.0),
    );
    var uv = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(1.0, 0.0),
    );

    var pos: vec2<f32> = indexes[idx];
    pos.y *= (1.0 - window_uniforms.toolbar_percentage);
    pos.y -= window_uniforms.toolbar_percentage;

    out.position = vec4<f32>(pos, 0.0, 1.0);
    out.uv = uv[idx];
    return out;
}

fn squircle_norm(p: vec2<f32>, power: f32) -> f32 {
    let x = pow(abs(p.x), power);
    let y = pow(abs(p.y), power);
    return pow(x + y, 1.0 / power);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Calculate the effective rendering dimensions (accounting for toolbar)
    let effective_height = window_uniforms.window_height * (1.0 - window_uniforms.toolbar_percentage);
    let crop_width = window_uniforms.window_width;
    let crop_height = effective_height;
    let crop_aspect = crop_width / crop_height;
    let camera_aspect = camera_uniforms.camera_aspect_ratio;

    // Calculate UV coordinates for proper "cover" behavior
    var final_uv = in.uv;

    // Determine which dimension needs to be scaled to cover the crop region
    if (camera_aspect > crop_aspect) {
        // Camera is wider than crop region - scale horizontally
        let scale = crop_aspect / camera_aspect;
        let offset = (1.0 - scale) * 0.5;
        final_uv.x = final_uv.x * scale + offset;
    } else {
        // Camera is taller than crop region - scale vertically
        let scale = camera_aspect / crop_aspect;
        let offset = (1.0 - scale) * 0.5;
        final_uv.y = final_uv.y * scale + offset;
    }

    // Apply mirroring if enabled
    if (uniforms.mirrored == 1.0) {
        final_uv.x = 1.0 - final_uv.x;
    }

    // Shape constants: 0 = Round, 1 = Square, 2 = Full
    // Size constants: 0 = Sm, 1 = Lg
    let shape = uniforms.shape;
    let size = uniforms.size;

    // Convert UV coordinates to center-based coordinates [-1, 1]
    let center_uv = (in.uv - 0.5) * 2.0;

    var mask = 1.0;

    if (shape == 0.0) {
        // Round shape with enhanced anti-aliasing
        let distance = length(center_uv);
        let radius = 1.0;

        // Multi-level anti-aliasing approach
        let pixel_size = length(fwidth(center_uv));
        let aa_width = max(pixel_size, 0.003); // Reduced minimum AA width

        // Primary edge calculation
        let edge_distance = distance - radius;
        mask = 1.0 - smoothstep(-aa_width, aa_width, edge_distance);

    } else if (shape == 1.0) {
        // Square shape with enhanced corner anti-aliasing
        let corner_radius = select(0.1, 0.12, size == 1.0);
        let abs_uv = abs(center_uv);
        let corner_pos = abs_uv - (1.0 - corner_radius);
        let corner_norm = squircle_norm(max(corner_pos, vec2<f32>(0.0, 0.0)), 4.0);

        // Enhanced anti-aliasing for corners
        let pixel_size = length(fwidth(center_uv));
        let aa_width = max(pixel_size, 0.002);

        let edge_distance = corner_norm - corner_radius;
        mask = 1.0 - smoothstep(-aa_width, aa_width, edge_distance);
    } else if (shape == 2.0) {
        // Full shape with aspect ratio-corrected rounded corners
        let window_aspect = window_uniforms.window_width / window_uniforms.window_height;
        let corner_radius = select(0.08, 0.1, size == 1.0); // radius based on size (8% for small, 10% for large)

        let abs_uv = abs(center_uv);
        let corner_pos = abs_uv - (1.0 - corner_radius);

        // Use aspect-ratio aware distance calculation for circular corners
        var adjusted_corner_pos = max(corner_pos, vec2<f32>(0.0, 0.0));
        if (window_aspect > 1.0) {
            // For wide windows, scale X component to make distance calculation circular
            adjusted_corner_pos.x *= window_aspect;
        } else {
            // For tall windows, scale Y component to make distance calculation circular
            adjusted_corner_pos.y /= window_aspect;
        }

        let corner_dist = length(adjusted_corner_pos);

        // Enhanced anti-aliasing for corners
        let pixel_size = length(fwidth(center_uv));
        let aa_width = max(pixel_size, 0.002);

        let edge_distance = corner_dist - corner_radius;
        mask = 1.0 - smoothstep(-aa_width, aa_width, edge_distance);
    } else {
        // For any other shape, default to no masking (rectangular)
        mask = 1.0;
    }

    // Apply the mask with cleaner alpha handling to reduce ghosting
    if (mask < 0.05) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    // Sample the camera texture
    let camera_color = textureSample(t_camera, s_camera, final_uv);

    // Use sharper alpha cutoff to reduce ghosting
    let final_alpha = select(1.0, mask, mask < 0.95);
    return vec4<f32>(camera_color.rgb, final_alpha);
}
