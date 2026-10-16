@group(0) @binding(0) var y_plane: texture_2d<f32>;
@group(0) @binding(1) var u_plane: texture_2d<f32>;
@group(0) @binding(2) var v_plane: texture_2d<f32>;
@group(0) @binding(3) var output: texture_storage_2d<rgba8unorm, write>;

// One invocation per pixel.
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;
    let dims = textureDimensions(output);
    let uv = load_uv(coords / 2u);
    convert_pixel(coords, dims, uv.x, uv.y);
}

// One invocation per 2x2 block: the block shares its chroma sample, so this loads U and V once instead of four times.
@compute @workgroup_size(8, 8)
fn main_block(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let uv_coords = global_id.xy;
    let dims = textureDimensions(output);
    let uv = load_uv(uv_coords);

    let origin = uv_coords * 2u;
    convert_pixel(origin, dims, uv.x, uv.y);
    convert_pixel(origin + vec2<u32>(1u, 0u), dims, uv.x, uv.y);
    convert_pixel(origin + vec2<u32>(0u, 1u), dims, uv.x, uv.y);
    convert_pixel(origin + vec2<u32>(1u, 1u), dims, uv.x, uv.y);
}

fn load_uv(uv_coords: vec2<u32>) -> vec2<f32> {
    let u_dims = textureDimensions(u_plane);
    let v_dims = textureDimensions(v_plane);
    let u_clamped = min(uv_coords, u_dims - vec2<u32>(1, 1));
    let v_clamped = min(uv_coords, v_dims - vec2<u32>(1, 1));
    return vec2<f32>(
        textureLoad(u_plane, u_clamped, 0).r,
        textureLoad(v_plane, v_clamped, 0).r
    );
}

fn convert_pixel(coords: vec2<u32>, dims: vec2<u32>, u_raw: f32, v_raw: f32) {
    if (coords.x >= dims.x || coords.y >= dims.y) {
        return;
    }

    let y_raw = textureLoad(y_plane, coords, 0).r;

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
