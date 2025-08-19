@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;
    let dims = textureDimensions(output);

    if (coords.x >= dims.x || coords.y >= dims.y) {
        return;
    }

    // Load BGRA pixel
    let bgra = textureLoad(input_texture, coords, 0);

    // Swizzle BGRA to RGBA
    let rgba = vec4<f32>(bgra.b, bgra.g, bgra.r, bgra.a);

    textureStore(output, coords, rgba);
}
