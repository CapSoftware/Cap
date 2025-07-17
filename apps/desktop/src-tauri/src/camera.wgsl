struct Uniforms {
    window_height: f32,
    offset_pixels: f32,
    shape: f32,
    size: f32,
    mirrored: f32,
    _padding: f32,
}

@group(1) @binding(0)
var<uniform> uniforms: Uniforms;

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

    // Calculate offset in normalized coordinates
    let offset_y = (uniforms.offset_pixels / uniforms.window_height) * 2.0;

    // Calculate the available height for the camera content
    let available_height = uniforms.window_height - uniforms.offset_pixels;
    let scale_factor = available_height / uniforms.window_height;

    // Scale the Y coordinate to fit the available space
    let scaled_y = pos[idx].y * scale_factor;

    // Position the scaled quad in the bottom portion of the screen
    // Available space bottom: -1.0, top: (1.0 - offset_y)
    // Map scaled_y from [-1,1] to the available space
    let available_range = 2.0 - offset_y; // total height of available space
    let final_y = -1.0 + (scaled_y + 1.0) * available_range / 2.0;

    let adjusted_pos = vec2<f32>(pos[idx].x, final_y);

    // Mark pixels in the offset area as transparent
    let is_offset_area = select(0.0, 1.0, adjusted_pos.y > (1.0 - offset_y));

    out.position = vec4<f32>(adjusted_pos, 0.0, 1.0);
    out.uv = uv[idx];
    out.offset_area = is_offset_area;
    return out;
}

@group(0) @binding(0)
var t_camera: texture_2d<f32>;
@group(0) @binding(1)
var s_camera: sampler;

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    // If we're in the offset area, return transparent
    if (in.offset_area > 0.5) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    // Shape constants: 0 = Round, 1 = Square, 2 = Full
    // Size constants: 0 = Sm, 1 = Lg
    let shape = uniforms.shape;
    let size = uniforms.size;

    // For Full shape, render with subtle rounded corners
    if (shape == 2.0) {
        // Apply mirroring if enabled
        var final_uv = in.uv;
        if (uniforms.mirrored == 1.0) {
            final_uv.x = 1.0 - final_uv.x;
        }

        // Apply subtle rounded corners for Full shape
        let center_uv = (in.uv - 0.5) * 2.0;
        let corner_radius = 0.05; // Small radius for subtle corners
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

    // Apply mirroring if enabled
    var final_uv = in.uv;
    if (uniforms.mirrored == 1.0) {
        final_uv.x = 1.0 - final_uv.x;
    }

    // Sample the camera texture
    let camera_color = textureSample(t_camera, s_camera, final_uv);
    return vec4<f32>(camera_color.rgb, 1.0);
}
