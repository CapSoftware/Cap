@group(0) @binding(0)
var bgra_input: texture_2d<f32>;

@group(0) @binding(1)
var rgba_output: texture_storage_2d<rgba8unorm, write>;

@compute
@workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let dims = textureDimensions(bgra_input);
    if (global_id.x >= dims.x || global_id.y >= dims.y) {
        return;
    }

    let bgra = textureLoad(bgra_input, global_id.xy, 0);

    let rgba = vec4<f32>(bgra.b, bgra.g, bgra.r, bgra.a);

    textureStore(rgba_output, global_id.xy, rgba);
}
