// NV12 planes a browser decoder handed over. The browser encodes the rendered
// frame back to YUV as BT.709, so decoding with BT.709 here keeps exported
// colours where the browser's own conversion and native exports put them.
override FULL_RANGE: bool = false;
override SMOOTH_CHROMA: bool = false;

@group(0) @binding(0) var y_plane: texture_2d<f32>;
@group(0) @binding(1) var uv_plane: texture_2d<f32>;
@group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;

// Safari rescales the decoder's video range codes to full range and rounds;
// rescaling back and rounding recovers them exactly, where converting the
// rounded full range codes is up to 1.4 levels off.
fn y_code(coords: vec2<i32>) -> f32 {
    let code = textureLoad(y_plane, coords, 0).r * 255.0;
    if (FULL_RANGE) {
        return round(code * (219.0 / 255.0) + 16.0);
    }
    return code;
}

fn uv_code(coords: vec2<i32>) -> vec2<f32> {
    let code = textureLoad(uv_plane, coords, 0).rg * 255.0;
    if (FULL_RANGE) {
        return round((code - vec2<f32>(128.0)) * (224.0 / 255.0) + vec2<f32>(128.0));
    }
    return code;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;
    let dims = textureDimensions(output);

    if (coords.x >= dims.x || coords.y >= dims.y) {
        return;
    }

    let uv_max = vec2<i32>(textureDimensions(uv_plane)) - vec2<i32>(1, 1);
    // Each chroma sample covers a 2x2 block of luma, as native playback reads it.
    var uv_value = uv_code(min(vec2<i32>(coords / 2), uv_max));
    if (SMOOTH_CHROMA) {
        // Each chroma sample sits level with the even luma row and column,
        // where Safari's own conversion puts it. A browser encoder takes
        // chroma back from the rendered frame without filtering, so blocky
        // chroma, sharpened by the downscale, would come back as chroma noise.
        let uv_pos = vec2<f32>(coords) * 0.5;
        let uv_base = floor(uv_pos);
        let uv_weight = uv_pos - uv_base;
        let uv_a = clamp(vec2<i32>(uv_base), vec2<i32>(0, 0), uv_max);
        let uv_b = clamp(vec2<i32>(uv_base) + vec2<i32>(1, 1), vec2<i32>(0, 0), uv_max);
        let uv_top = mix(uv_code(uv_a), uv_code(vec2<i32>(uv_b.x, uv_a.y)), uv_weight.x);
        let uv_bottom = mix(uv_code(vec2<i32>(uv_a.x, uv_b.y)), uv_code(uv_b), uv_weight.x);
        uv_value = mix(uv_top, uv_bottom, uv_weight.y);
    }

    let y = (y_code(vec2<i32>(coords)) - 16.0) / 219.0;
    let uv = (uv_value - vec2<f32>(128.0)) / 224.0;

    let r = y + 1.5748 * uv.g;
    let g = y - 0.1873 * uv.r - 0.4681 * uv.g;
    let b = y + 1.8556 * uv.r;

    textureStore(output, coords, vec4<f32>(clamp(vec3<f32>(r, g, b), vec3<f32>(0.0), vec3<f32>(1.0)), 1.0));
}
