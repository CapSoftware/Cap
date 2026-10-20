// Limited-range Y'CbCr to RGB: luma 16..235, chroma centred on 128. The
// chroma coefficients are pipeline overrides (YuvMatrix::shader_constants):
// BT.601 by default, BT.709 for sources tagged BT.709.
override RV: f32 = 1.596027;
override GU: f32 = 0.391762;
override GV: f32 = 0.812968;
override BU: f32 = 2.017232;

@group(0) @binding(0) var y_plane: texture_2d<f32>;
@group(0) @binding(1) var u_plane: texture_2d<f32>;
@group(0) @binding(2) var v_plane: texture_2d<f32>;
@group(0) @binding(3) var output: texture_storage_2d<rgba8unorm, write>;

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

    let y = (y_raw - 16.0 / 255.0) * (255.0 / 219.0);
    let u = u_raw - 128.0 / 255.0;
    let v = v_raw - 128.0 / 255.0;

    let r = y + RV * v;
    let g = y - GU * u - GV * v;
    let b = y + BU * u;

    let color = vec4<f32>(
        clamp(r, 0.0, 1.0),
        clamp(g, 0.0, 1.0),
        clamp(b, 0.0, 1.0),
        1.0
    );

    textureStore(output, coords, color);
}
