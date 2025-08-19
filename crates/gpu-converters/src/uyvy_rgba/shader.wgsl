@group(0) @binding(0) var<storage, read> input_buffer: array<u32>;
@group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> dimensions: vec2<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;
    let dims = dimensions;

    if (coords.x >= dims.x || coords.y >= dims.y) {
        return;
    }

    // UYVY format: U Y V Y (4 bytes for 2 pixels)
    // Each pair of horizontal pixels shares U and V values
    let pixel_pair_index = coords.x / 2u;
    let is_odd_pixel = (coords.x % 2u) == 1u;
    let row_index = coords.y;

    // Calculate byte index for this pixel pair
    let byte_index = (row_index * dims.x + pixel_pair_index * 2u) * 2u;
    let word_index = byte_index / 4u;
    let byte_offset = byte_index % 4u;

    var y: u32;
    var u: u32;
    var v: u32;

    // Extract UYVY components based on alignment
    if (byte_offset == 0u) {
        // UYVY starts at word boundary: [UYVY]
        let word = input_buffer[word_index];
        let u_val = (word >> 0u) & 0xFFu;
        let y0 = (word >> 8u) & 0xFFu;
        let v_val = (word >> 16u) & 0xFFu;
        let y1 = (word >> 24u) & 0xFFu;

        y = select(y0, y1, is_odd_pixel);
        u = u_val;
        v = v_val;
    } else if (byte_offset == 1u) {
        // UYVY spans boundary: [?UYV][Y???]
        let word0 = input_buffer[word_index];
        let word1 = input_buffer[word_index + 1u];
        let u_val = (word0 >> 8u) & 0xFFu;
        let y0 = (word0 >> 16u) & 0xFFu;
        let v_val = (word0 >> 24u) & 0xFFu;
        let y1 = (word1 >> 0u) & 0xFFu;

        y = select(y0, y1, is_odd_pixel);
        u = u_val;
        v = v_val;
    } else if (byte_offset == 2u) {
        // UYVY spans boundary: [??UY][VY??]
        let word0 = input_buffer[word_index];
        let word1 = input_buffer[word_index + 1u];
        let u_val = (word0 >> 16u) & 0xFFu;
        let y0 = (word0 >> 24u) & 0xFFu;
        let v_val = (word1 >> 0u) & 0xFFu;
        let y1 = (word1 >> 8u) & 0xFFu;

        y = select(y0, y1, is_odd_pixel);
        u = u_val;
        v = v_val;
    } else {
        // UYVY spans boundary: [???U][YVY?]
        let word0 = input_buffer[word_index];
        let word1 = input_buffer[word_index + 1u];
        let u_val = (word0 >> 24u) & 0xFFu;
        let y0 = (word1 >> 0u) & 0xFFu;
        let v_val = (word1 >> 8u) & 0xFFu;
        let y1 = (word1 >> 16u) & 0xFFu;

        y = select(y0, y1, is_odd_pixel);
        u = u_val;
        v = v_val;
    }

    // Convert to normalized float values
    let y_norm = f32(y) / 255.0;
    let u_norm = f32(u) / 255.0 - 0.5;
    let v_norm = f32(v) / 255.0 - 0.5;

    // YUV to RGB conversion (ITU-R BT.601)
    let r = y_norm + 1.402 * v_norm;
    let g = y_norm - 0.344 * u_norm - 0.714 * v_norm;
    let b = y_norm + 1.772 * u_norm;

    let rgba = vec4<f32>(
        clamp(r, 0.0, 1.0),
        clamp(g, 0.0, 1.0),
        clamp(b, 0.0, 1.0),
        1.0
    );

    textureStore(output, coords, rgba);
}
