@group(0) @binding(0) var y_plane: texture_2d<f32>;
@group(0) @binding(1) var u_plane: texture_2d<f32>;
@group(0) @binding(2) var v_plane: texture_2d<f32>;
@group(0) @binding(3) var output: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;
    let dims = textureDimensions(output);

    if (coords.x >= dims.x || coords.y >= dims.y) {
        return;
    }

    // Sample Y plane at full resolution
    let y = textureLoad(y_plane, coords, 0).r;

    // Sample U and V planes at half resolution (4:2:0 subsampling)
    let uv_coords = coords / 2;
    let u = textureLoad(u_plane, uv_coords, 0).r;
    let v = textureLoad(v_plane, uv_coords, 0).r;

    // Convert from YUV to RGB color space
    // Using ITU-R BT.601 conversion matrix
    let u_centered = u - 0.5;
    let v_centered = v - 0.5;

    let r = y + 1.402 * v_centered;
    let g = y - 0.344 * u_centered - 0.714 * v_centered;
    let b = y + 1.772 * u_centered;

    let rgba = vec4<f32>(
        clamp(r, 0.0, 1.0),
        clamp(g, 0.0, 1.0),
        clamp(b, 0.0, 1.0),
        1.0
    );

    textureStore(output, coords, rgba);
}
