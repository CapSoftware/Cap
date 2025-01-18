@group(0) @binding(0)
var rgba_input: texture_2d<f32>;

@group(0) @binding(1)
var uyvy_output: texture_storage_2d<rgba8unorm, write>;

@compute
@workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;

    // Get two adjacent RGBA pixels
    let input_coords = coords * vec2<u32>(2, 1);
    let rgba1 = textureLoad(rgba_input, input_coords, 0);
    let rgba2 = textureLoad(rgba_input, input_coords + vec2<u32>(1, 0), 0);

    // Convert RGB to YUV for first pixel
    let y1 = 0.299 * rgba1.r + 0.587 * rgba1.g + 0.114 * rgba1.b;
    let u1 = -0.147 * rgba1.r - 0.289 * rgba1.g + 0.436 * rgba1.b + 0.5;
    let v1 = 0.615 * rgba1.r - 0.515 * rgba1.g - 0.100 * rgba1.b + 0.5;

    // Convert RGB to YUV for second pixel
    let y2 = 0.299 * rgba2.r + 0.587 * rgba2.g + 0.114 * rgba2.b;
    let u2 = -0.147 * rgba2.r - 0.289 * rgba2.g + 0.436 * rgba2.b + 0.5;
    let v2 = 0.615 * rgba2.r - 0.515 * rgba2.g - 0.100 * rgba2.b + 0.5;

    // Average the U and V values
    let u = (u1 + u2) * 0.5;
    let v = (v1 + v2) * 0.5;

    // Store as UYVY
    textureStore(uyvy_output, coords, vec4<f32>(u, y1, v, y2));
}
