struct StateUniforms {
    offset_pixels: f32,
    shape: f32,
    size: f32,
    mirrored: f32,
    _padding: f32,
}

struct WindowUniforms {
    window_height: f32,
    window_width: f32,
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
    @location(1) offset_area: f32,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOut {
    var pos = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), // bottom left
        vec2<f32>( 1.0, -1.0), // bottom right
        vec2<f32>(-1.0,  1.0), // top left
        vec2<f32>(-1.0,  1.0), // top left
        vec2<f32>( 1.0, -1.0), // bottom right
        vec2<f32>( 1.0,  1.0), // top right
    );
    var uv = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(1.0, 0.0),
    );
    var out: VertexOut;

    // Apply 16px padding using unified NDC transformation
    let padding = 16.0;
    
    // Define target viewport in pixel space (with padding and toolbar offset)
    // Ensure we have positive dimensions by clamping padding
    let max_horizontal_padding = window_uniforms.window_width * 0.4; // Max 40% padding
    let max_vertical_padding = (window_uniforms.window_height - uniforms.offset_pixels) * 0.4;
    let effective_padding = min(padding, min(max_horizontal_padding, max_vertical_padding));
    
    let target_left = effective_padding;
    let target_right = window_uniforms.window_width - effective_padding;
    let target_top = uniforms.offset_pixels + effective_padding;  
    let target_bottom = window_uniforms.window_height - effective_padding;
    
    // Convert original [-1,1] NDC coordinates to target viewport pixel coordinates
    let pixel_x = (pos[idx].x + 1.0) * 0.5 * (target_right - target_left) + target_left;
    let pixel_y = (1.0 - pos[idx].y) * 0.5 * (target_bottom - target_top) + target_top;
    
    // Convert back to NDC space
    let ndc_x = (pixel_x / window_uniforms.window_width) * 2.0 - 1.0;
    let ndc_y = 1.0 - (pixel_y / window_uniforms.window_height) * 2.0;
    
    let adjusted_pos = vec2<f32>(ndc_x, ndc_y);

    out.position = vec4<f32>(adjusted_pos, 0.0, 1.0);
    out.uv = uv[idx];
    out.offset_area = 0.0; // No offset area needed with correct positioning
    return out;
}

@group(0) @binding(0)
var t_camera: texture_2d<f32>;
@group(0) @binding(1)
var s_camera: sampler;

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    // Calculate the crop region dimensions with padding and inset applied
    let padding = 16.0;
    let crop_width = window_uniforms.window_width - 2.0 * padding;
    let crop_height = window_uniforms.window_height - uniforms.offset_pixels - 2.0 * padding;
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

    // For Full shape, render with rounded corners
    if (shape == 2.0) {
        // Apply rounded corners for Full shape
        // Use in.uv for corner calculation to avoid distortion from aspect ratio scaling
        let center_uv = (in.uv - 0.5) * 2.0;
        let corner_radius = select(0.08, 0.1, size == 1.0); // radius based on size (8% for small, 10% for large)
        let abs_uv = abs(center_uv);
        let corner_pos = abs_uv - (1.0 - corner_radius);
        let corner_dist = length(max(corner_pos, vec2<f32>(0.0, 0.0)));
        let mask = select(0.0, 1.0, corner_dist <= corner_radius);

        if (mask < 0.5) {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }

        let camera_color = textureSample(t_camera, s_camera, final_uv);
        return vec4<f32>(camera_color.rgb, 1.0);
    }

    // Convert UV coordinates to center-based coordinates [-1, 1]
    let center_uv = (in.uv - 0.5) * 2.0;

    var mask = 1.0;

    if (shape == 0.0) {
        // Round shape - create circular mask (border-radius: 9999px equivalent)
        let distance = length(center_uv);
        mask = select(0.0, 1.0, distance <= 1.0);
    } else if (shape == 1.0) {
        // Square shape - apply rounded corners based on size
        // Use a reasonable corner radius for the square shape
        let corner_radius = select(0.1, 0.12, size == 1.0); // radius in UV space (0.1 = 10% of quad size)

        // Calculate distance from corners for rounded rectangle
        let abs_uv = abs(center_uv);
        let corner_pos = abs_uv - (1.0 - corner_radius);
        let corner_dist = length(max(corner_pos, vec2<f32>(0.0, 0.0)));

        // Apply rounded corner mask
        mask = select(0.0, 1.0, corner_dist <= corner_radius);
    } else {
        // For any other shape, default to no masking (rectangular)
        mask = 1.0;
    }

    // Apply the mask
    if (mask < 0.5) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    // Sample the camera texture
    let camera_color = textureSample(t_camera, s_camera, final_uv);
    return vec4<f32>(camera_color.rgb, 1.0);
}
