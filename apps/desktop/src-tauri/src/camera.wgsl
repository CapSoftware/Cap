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

    let padding = 16.0;
    let max_horizontal_padding = window_uniforms.window_width * 0.4; // Max 40% padding
    let max_vertical_padding = window_uniforms.window_height * 0.4;
    let effective_padding = min(padding, min(max_horizontal_padding, max_vertical_padding));
    let target_left = effective_padding;
    let target_right = window_uniforms.window_width - effective_padding;
    let target_top = effective_padding;
    let target_bottom = window_uniforms.window_height - effective_padding;
    let content_width = target_right - target_left;
    let content_height = target_bottom - target_top;
    let content_aspect = content_width / content_height;
    var render_width = content_width;
    var render_height = content_height;
    var actual_target_bottom = target_bottom;
    var actual_target_top = target_top;
    var actual_target_left = target_left;
    var actual_target_right = target_right;

    // Convert original [-1,1] NDC coordinates to target viewport pixel coordinates
    let pixel_x = (pos[idx].x + 1.0) * 0.5 * (actual_target_right - actual_target_left) + actual_target_left;
    let pixel_y = (1.0 - pos[idx].y) * 0.5 * (actual_target_bottom - actual_target_top) + actual_target_top;
    let ndc_x = (pixel_x / window_uniforms.window_width) * 2.0 - 1.0;
    let ndc_y = 1.0 - (pixel_y / window_uniforms.window_height) * 2.0;
    let adjusted_pos = vec2<f32>(ndc_x, ndc_y);
    out.position = vec4<f32>(adjusted_pos, 0.0, 1.0);
    out.uv = uv[idx];
    out.offset_area = 0.0;
    return out;
}

@group(0) @binding(0)
var t_camera: texture_2d<f32>;
@group(0) @binding(1)
var s_camera: sampler;

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    let padding = 16.0;
    let max_horizontal_padding = window_uniforms.window_width * 0.4;
    let max_vertical_padding = window_uniforms.window_height * 0.4;
    let effective_padding = min(padding, min(max_horizontal_padding, max_vertical_padding));
    let target_top = effective_padding;
    let target_bottom = window_uniforms.window_height - effective_padding;
    let content_height = target_bottom - target_top;
    // Calculate the y position in window pixels
    let y_px = in.uv.y * window_uniforms.window_height;
    // Only apply green bar if inside the padded content area
    if (y_px >= target_top && y_px < target_top + (window_uniforms.toolbar_percentage * content_height)) {
        return vec4<f32>(0.0, 1.0, 0.0, 1.0);
    }

    // Calculate UV coordinates for proper "cover" behavior
    var final_uv = in.uv;

    // Determine which dimension needs to be scaled to cover the crop region
    if (camera_uniforms.camera_aspect_ratio > 1.0) { // Assuming content_aspect is 1.0 for now, as padding is commented out
        // Camera is wider than window - scale horizontally to fit height
        let scale = 1.0 / camera_uniforms.camera_aspect_ratio; // content_aspect / camera_aspect
        let offset = (1.0 - scale) * 0.5;
        final_uv.x = final_uv.x * scale + offset;
    } else {
        // Camera is taller than window - scale vertically to fit width, align to bottom
        let scale = camera_uniforms.camera_aspect_ratio / 1.0; // camera_aspect / content_aspect
        // Align to bottom by using full offset (UV 0 is top, 1 is bottom)
        let offset = 1.0 - scale;
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

    // Compute the vertical offset in normalized [-1, 1] space for toolbar padding
    let toolbar_offset = window_uniforms.toolbar_percentage * 2.0; // since [-1,1] is 2 units
    // The top of the shape should be at y = 1.0 - toolbar_offset
    // So the center is at y = (1.0 - toolbar_offset) - 1.0 (since all shapes are sized to fit in [-1,1])
    let shape_center_y = (1.0 - toolbar_offset) - 1.0;

    if (shape == 0.0) {
        // Round shape - create circular mask centered horizontally, offset downward by toolbar_percentage
        let aspect_ratio = window_uniforms.window_width / window_uniforms.window_height;
        let circle_radius = 1.0;
        let circle_center = vec2<f32>(0.0, shape_center_y);
        // Scale x by aspect ratio to make the circle round in screen space
        let scaled_uv = vec2<f32>(center_uv.x * aspect_ratio, center_uv.y - circle_center.y);
        let distance = length(scaled_uv);
        mask = select(0.0, 1.0, distance <= circle_radius);
    } else if (shape == 1.0) {
        // Square shape - apply rounded corners based on size, offset downward by toolbar_percentage
        let corner_radius = select(0.1, 0.12, size == 1.0); // radius in UV space (0.1 = 10% of quad size)
        let shifted_uv = center_uv - vec2<f32>(0.0, shape_center_y);
        let abs_uv = abs(shifted_uv);
        let corner_pos = abs_uv - (1.0 - corner_radius);
        let corner_dist = length(max(corner_pos, vec2<f32>(0.0, 0.0)));
        mask = select(0.0, 1.0, corner_dist <= corner_radius);
    } else if (shape == 2.0) {
        // Full shape - render with rounded corners, offset downward by toolbar_percentage
        let shifted_uv = center_uv - vec2<f32>(0.0, shape_center_y);
        let corner_radius = select(0.08, 0.1, size == 1.0); // radius based on size (8% for small, 10% for large)
        let abs_uv = abs(shifted_uv);
        let corner_pos = abs_uv - (1.0 - corner_radius);
        let corner_dist = length(max(corner_pos, vec2<f32>(0.0, 0.0)));
        let mask_full = select(0.0, 1.0, corner_dist <= corner_radius);
        if (mask_full < 0.5) {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
        let camera_color = textureSample(t_camera, s_camera, final_uv);
        return vec4<f32>(camera_color.rgb, 1.0);
    } else {
        // For any other shape, default to no masking (rectangular), but still apply vertical offset
        let shifted_uv = center_uv - vec2<f32>(0.0, shape_center_y);
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
