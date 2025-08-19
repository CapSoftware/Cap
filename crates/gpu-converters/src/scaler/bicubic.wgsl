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

// Bicubic interpolation weight function (Catmull-Rom)
fn cubic_weight(t: f32) -> f32 {
    let a = -0.5; // Catmull-Rom parameter
    let t2 = t * t;
    let t3 = t2 * t;

    if (abs(t) <= 1.0) {
        return (a + 2.0) * t3 - (a + 3.0) * t2 + 1.0;
    } else if (abs(t) <= 2.0) {
        return a * t3 - 5.0 * a * t2 + 8.0 * a * t - 4.0 * a;
    } else {
        return 0.0;
    }
}

// Sample texture with bounds checking
fn sample_clamped(coords: vec2<i32>) -> vec4<f32> {
    let clamped_x = clamp(coords.x, 0, i32(scale_params.input_width) - 1);
    let clamped_y = clamp(coords.y, 0, i32(scale_params.input_height) - 1);
    return textureLoad(input_texture, vec2<i32>(clamped_x, clamped_y), 0);
}

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

    // Find the center of the 4x4 sampling grid
    let center_x = floor(input_x);
    let center_y = floor(input_y);

    // Calculate fractional parts for interpolation
    let fx = input_x - center_x;
    let fy = input_y - center_y;

    // Sample 4x4 grid of pixels around the target point
    var color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    var weight_sum = 0.0;

    for (var j = -1; j <= 2; j++) {
        for (var i = -1; i <= 2; i++) {
            let sample_x = i32(center_x) + i;
            let sample_y = i32(center_y) + j;

            let pixel = sample_clamped(vec2<i32>(sample_x, sample_y));

            let weight_x = cubic_weight(fx - f32(i));
            let weight_y = cubic_weight(fy - f32(j));
            let weight = weight_x * weight_y;

            color += pixel * weight;
            weight_sum += weight;
        }
    }

    // Normalize by total weight and clamp to valid range
    if (weight_sum > 0.0) {
        color = color / weight_sum;
    }

    color = clamp(color, vec4<f32>(0.0), vec4<f32>(1.0));

    textureStore(output, output_coords, color);
}
