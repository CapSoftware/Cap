// Limited-range Y'CbCr to RGB: luma 16..235, chroma centred on 128. The
// chroma coefficients are pipeline overrides (YuvMatrix::shader_constants):
// BT.601 by default, BT.709 for sources tagged BT.709.
override RV: f32 = 1.596027;
override GU: f32 = 0.391762;
override GV: f32 = 0.812968;
override BU: f32 = 2.017232;

@group(0) @binding(0) var y_plane: texture_2d<f32>;
@group(0) @binding(1) var uv_plane: texture_2d<f32>;
@group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;
    let dims = textureDimensions(output);

    if (coords.x >= dims.x || coords.y >= dims.y) {
        return;
    }

    let y_raw = textureLoad(y_plane, coords, 0).r;

    let uv_coords = coords / 2;
    let uv_dims = textureDimensions(uv_plane);
    let uv_clamped = min(uv_coords, uv_dims - vec2<u32>(1, 1));
    let uv_raw = textureLoad(uv_plane, uv_clamped, 0).rg;

    let y = (y_raw - 16.0 / 255.0) * (255.0 / 219.0);
    let u = uv_raw.r - 128.0 / 255.0;
    let v = uv_raw.g - 128.0 / 255.0;

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
