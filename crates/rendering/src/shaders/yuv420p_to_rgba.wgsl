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

    let y_raw = textureLoad(y_plane, coords, 0).r;

    let uv_coords = coords / 2;
    let u_raw = textureLoad(u_plane, uv_coords, 0).r;
    let v_raw = textureLoad(v_plane, uv_coords, 0).r;

    let y = (y_raw - 0.0625) * 1.164;
    let u = u_raw - 0.5;
    let v = v_raw - 0.5;

    let r = y + 1.596 * v;
    let g = y - 0.391 * u - 0.813 * v;
    let b = y + 2.018 * u;

    let color = vec4<f32>(
        clamp(r, 0.0, 1.0),
        clamp(g, 0.0, 1.0),
        clamp(b, 0.0, 1.0),
        1.0
    );

    textureStore(output, coords, color);
}
