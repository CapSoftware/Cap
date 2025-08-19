@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;

struct ScaleParams {
    input_width: f32,
    input_height: f32,
    output_width: f32,
    output_height: f32,
}

@group(1) @binding(0) var<uniform> scale_params: ScaleParams;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let output_coords = global_id.xy;
    let output_dims = textureDimensions(output);

    if (output_coords.x >= output_dims.x || output_coords.y >= output_dims.y) {
        return;
    }

    // Calculate scale factors
    let scale_x = scale_params.input_width / scale_params.output_width;
    let scale_y = scale_params.input_height / scale_params.output_height;

    // Map output coordinates to input coordinates with sub-pixel precision
    let input_x = (f32(output_coords.x) + 0.5) * scale_x - 0.5;
    let input_y = (f32(output_coords.y) + 0.5) * scale_y - 0.5;

    // Find the four neighboring pixels
    let x0 = floor(input_x);
    let y0 = floor(input_y);
    let x1 = x0 + 1.0;
    let y1 = y0 + 1.0;

    // Calculate interpolation weights
    let fx = input_x - x0;
    let fy = input_y - y0;

    // Clamp coordinates to valid range
    let x0_clamped = clamp(i32(x0), 0, i32(scale_params.input_width) - 1);
    let y0_clamped = clamp(i32(y0), 0, i32(scale_params.input_height) - 1);
    let x1_clamped = clamp(i32(x1), 0, i32(scale_params.input_width) - 1);
    let y1_clamped = clamp(i32(y1), 0, i32(scale_params.input_height) - 1);

    // Sample the four neighboring pixels
    let p00 = textureLoad(input_texture, vec2<i32>(x0_clamped, y0_clamped), 0);
    let p10 = textureLoad(input_texture, vec2<i32>(x1_clamped, y0_clamped), 0);
    let p01 = textureLoad(input_texture, vec2<i32>(x0_clamped, y1_clamped), 0);
    let p11 = textureLoad(input_texture, vec2<i32>(x1_clamped, y1_clamped), 0);

    // Perform bilinear interpolation
    let p0 = mix(p00, p10, fx);
    let p1 = mix(p01, p11, fx);
    let final_color = mix(p0, p1, fy);

    textureStore(output, output_coords, final_color);
}
