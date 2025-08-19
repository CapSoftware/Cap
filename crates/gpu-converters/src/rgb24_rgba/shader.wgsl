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

    // Calculate pixel index
    let pixel_index = coords.y * dims.x + coords.x;

    // Each pixel is 3 bytes (RGB), but we're reading u32s
    // So we need to handle the packing carefully
    let byte_index = pixel_index * 3u;
    let word_index = byte_index / 4u;
    let byte_offset = byte_index % 4u;

    var r: u32;
    var g: u32;
    var b: u32;

    // Handle different byte alignments within the u32 words
    if (byte_offset == 0u) {
        // RGB starts at word boundary: [RGB?]
        let word = input_buffer[word_index];
        r = (word >> 0u) & 0xFFu;
        g = (word >> 8u) & 0xFFu;
        b = (word >> 16u) & 0xFFu;
    } else if (byte_offset == 1u) {
        // RGB starts at byte 1: [?RGB]
        let word = input_buffer[word_index];
        r = (word >> 8u) & 0xFFu;
        g = (word >> 16u) & 0xFFu;
        b = (word >> 24u) & 0xFFu;
    } else if (byte_offset == 2u) {
        // RGB spans two words: [??RG][B???]
        let word0 = input_buffer[word_index];
        let word1 = input_buffer[word_index + 1u];
        r = (word0 >> 16u) & 0xFFu;
        g = (word0 >> 24u) & 0xFFu;
        b = (word1 >> 0u) & 0xFFu;
    } else {
        // RGB spans two words: [???R][GB??]
        let word0 = input_buffer[word_index];
        let word1 = input_buffer[word_index + 1u];
        r = (word0 >> 24u) & 0xFFu;
        g = (word1 >> 0u) & 0xFFu;
        b = (word1 >> 8u) & 0xFFu;
    }

    // Convert to normalized float values and create RGBA
    let rgba = vec4<f32>(
        f32(r) / 255.0,
        f32(g) / 255.0,
        f32(b) / 255.0,
        1.0  // Alpha = 1.0 (opaque)
    );

    textureStore(output, coords, rgba);
}
