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

    // Map output coordinates to input coordinates (nearest neighbor)
    let input_x = i32(f32(output_coords.x) * scale_x);
    let input_y = i32(f32(output_coords.y) * scale_y);

    // Clamp to input bounds
    let clamped_x = clamp(input_x, 0, i32(scale_params.input_width) - 1);
    let clamped_y = clamp(input_y, 0, i32(scale_params.input_height) - 1);

    // Sample the input texture at the nearest pixel
    let color = textureLoad(input_texture, vec2<i32>(clamped_x, clamped_y), 0);

    textureStore(output, output_coords, color);
}
