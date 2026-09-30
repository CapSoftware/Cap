// NV12 planes a browser decoder handed over. The browser encodes the rendered
// frame back to YUV as BT.709, so decoding with BT.709 here keeps exported
// colours where the browser's own conversion and native exports put them.
override FULL_RANGE: bool = false;

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

    let uv_coords = coords / 2;
    let uv_dims = textureDimensions(uv_plane);
    let uv_clamped = min(uv_coords, uv_dims - vec2<u32>(1, 1));

    var y_code = textureLoad(y_plane, coords, 0).r * 255.0;
    var uv_code = textureLoad(uv_plane, uv_clamped, 0).rg * 255.0;
    if (FULL_RANGE) {
        // Safari rescales the decoder's video range codes to full range and
        // rounds; rescaling back and rounding recovers them exactly, where
        // converting the rounded full range codes is up to 1.4 levels off.
        y_code = round(y_code * (219.0 / 255.0) + 16.0);
        uv_code = round((uv_code - vec2<f32>(128.0)) * (224.0 / 255.0) + vec2<f32>(128.0));
    }

    let y = (y_code - 16.0) / 219.0;
    let uv = (uv_code - vec2<f32>(128.0)) / 224.0;

    let r = y + 1.5748 * uv.g;
    let g = y - 0.1873 * uv.r - 0.4681 * uv.g;
    let b = y + 1.8556 * uv.r;

    textureStore(output, coords, vec4<f32>(clamp(vec3<f32>(r, g, b), vec3<f32>(0.0), vec3<f32>(1.0)), 1.0));
}
