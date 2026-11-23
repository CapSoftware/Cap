struct Params {
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
}

@group(0) @binding(0) var input: texture_2d<f32>;
@group(0) @binding(1) var y_output: texture_storage_2d<r8unorm, write>;
@group(0) @binding(2) var uv_output: texture_storage_2d<rg8unorm, write>;
@group(0) @binding(3) var<uniform> params: Params;

// Same code values as rgba_to_nv12.wgsl, stored straight into the NV12
// IOSurface planes. A code value c is written as c / 255, which the unorm8
// store rounds back to exactly c.
fn rgb_to_y(r: f32, g: f32, b: f32) -> u32 {
    return u32(clamp(16.5 + 46.5594 * r + 156.6288 * g + 15.8118 * b, 0.0, 255.0));
}

fn rgb_to_u(r: f32, g: f32, b: f32) -> u32 {
    return u32(clamp(128.5 - 25.6642 * r - 86.3358 * g + 112.0 * b, 0.0, 255.0));
}

fn rgb_to_v(r: f32, g: f32, b: f32) -> u32 {
    return u32(clamp(128.5 + 112.0 * r - 101.7303 * g - 10.2697 * b, 0.0, 255.0));
}

fn code(value: u32) -> f32 {
    return f32(value) / 255.0;
}

fn safe_load(coord: vec2<u32>, dims: vec2<u32>) -> vec4<f32> {
    let c = min(coord, dims - vec2<u32>(1u, 1u));
    return textureLoad(input, c, 0);
}

fn store_y(x: u32, y: u32, value: u32) {
    if (x < params.width) {
        textureStore(y_output, vec2<u32>(x, y), vec4<f32>(code(value), 0.0, 0.0, 0.0));
    }
}

fn store_uv(x: u32, y: u32, u: u32, v: u32) {
    if (x < params.width / 2u && y < params.height / 2u) {
        textureStore(uv_output, vec2<u32>(x, y), vec4<f32>(code(u), code(v), 0.0, 0.0));
    }
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let width = params.width;
    let height = params.height;
    let dims = vec2<u32>(width, height);

    let px = global_id.x * 4u;
    let py = global_id.y * 2u;

    if (px >= width || py >= height) {
        return;
    }

    let p0 = safe_load(vec2<u32>(px, py), dims);
    let p1 = safe_load(vec2<u32>(px + 1u, py), dims);
    let p2 = safe_load(vec2<u32>(px + 2u, py), dims);
    let p3 = safe_load(vec2<u32>(px + 3u, py), dims);

    let p4 = safe_load(vec2<u32>(px, py + 1u), dims);
    let p5 = safe_load(vec2<u32>(px + 1u, py + 1u), dims);
    let p6 = safe_load(vec2<u32>(px + 2u, py + 1u), dims);
    let p7 = safe_load(vec2<u32>(px + 3u, py + 1u), dims);

    store_y(px, py, rgb_to_y(p0.r, p0.g, p0.b));
    store_y(px + 1u, py, rgb_to_y(p1.r, p1.g, p1.b));
    store_y(px + 2u, py, rgb_to_y(p2.r, p2.g, p2.b));
    store_y(px + 3u, py, rgb_to_y(p3.r, p3.g, p3.b));

    if (py + 1u < height) {
        store_y(px, py + 1u, rgb_to_y(p4.r, p4.g, p4.b));
        store_y(px + 1u, py + 1u, rgb_to_y(p5.r, p5.g, p5.b));
        store_y(px + 2u, py + 1u, rgb_to_y(p6.r, p6.g, p6.b));
        store_y(px + 3u, py + 1u, rgb_to_y(p7.r, p7.g, p7.b));
    }

    let avg_r_left = (p0.r + p1.r + p4.r + p5.r) * 0.25;
    let avg_g_left = (p0.g + p1.g + p4.g + p5.g) * 0.25;
    let avg_b_left = (p0.b + p1.b + p4.b + p5.b) * 0.25;

    let avg_r_right = (p2.r + p3.r + p6.r + p7.r) * 0.25;
    let avg_g_right = (p2.g + p3.g + p6.g + p7.g) * 0.25;
    let avg_b_right = (p2.b + p3.b + p6.b + p7.b) * 0.25;

    let uv_x = global_id.x * 2u;
    store_uv(
        uv_x,
        global_id.y,
        rgb_to_u(avg_r_left, avg_g_left, avg_b_left),
        rgb_to_v(avg_r_left, avg_g_left, avg_b_left),
    );
    store_uv(
        uv_x + 1u,
        global_id.y,
        rgb_to_u(avg_r_right, avg_g_right, avg_b_right),
        rgb_to_v(avg_r_right, avg_g_right, avg_b_right),
    );
}
