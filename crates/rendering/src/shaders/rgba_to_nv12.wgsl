struct Params {
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
}

@group(0) @binding(0) var input: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> nv12_output: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

fn rgb_to_y(r: f32, g: f32, b: f32) -> u32 {
    return u32(clamp(16.0 + 65.481 * r + 128.553 * g + 24.966 * b, 0.0, 255.0));
}

fn rgb_to_u(r: f32, g: f32, b: f32) -> u32 {
    return u32(clamp(128.0 - 37.797 * r - 74.203 * g + 112.0 * b, 0.0, 255.0));
}

fn rgb_to_v(r: f32, g: f32, b: f32) -> u32 {
    return u32(clamp(128.0 + 112.0 * r - 93.786 * g - 18.214 * b, 0.0, 255.0));
}

fn safe_load(coord: vec2<u32>, dims: vec2<u32>) -> vec4<f32> {
    let c = min(coord, dims - vec2<u32>(1u, 1u));
    return textureLoad(input, c, 0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let width = params.width;
    let height = params.height;
    let y_stride = params.y_stride;
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

    let y0 = rgb_to_y(p0.r, p0.g, p0.b);
    let y1 = rgb_to_y(p1.r, p1.g, p1.b);
    let y2 = rgb_to_y(p2.r, p2.g, p2.b);
    let y3 = rgb_to_y(p3.r, p3.g, p3.b);
    let y4 = rgb_to_y(p4.r, p4.g, p4.b);
    let y5 = rgb_to_y(p5.r, p5.g, p5.b);
    let y6 = rgb_to_y(p6.r, p6.g, p6.b);
    let y7 = rgb_to_y(p7.r, p7.g, p7.b);

    let y_row0_word = y0 | (y1 << 8u) | (y2 << 16u) | (y3 << 24u);
    let y_row0_idx = (py * y_stride + px) / 4u;
    nv12_output[y_row0_idx] = y_row0_word;

    if (py + 1u < height) {
        let y_row1_word = y4 | (y5 << 8u) | (y6 << 16u) | (y7 << 24u);
        let y_row1_idx = ((py + 1u) * y_stride + px) / 4u;
        nv12_output[y_row1_idx] = y_row1_word;
    }

    let y_plane_size = y_stride * height;

    let avg_r_left = (p0.r + p1.r + p4.r + p5.r) * 0.25;
    let avg_g_left = (p0.g + p1.g + p4.g + p5.g) * 0.25;
    let avg_b_left = (p0.b + p1.b + p4.b + p5.b) * 0.25;

    let avg_r_right = (p2.r + p3.r + p6.r + p7.r) * 0.25;
    let avg_g_right = (p2.g + p3.g + p6.g + p7.g) * 0.25;
    let avg_b_right = (p2.b + p3.b + p6.b + p7.b) * 0.25;

    let u_left = rgb_to_u(avg_r_left, avg_g_left, avg_b_left);
    let v_left = rgb_to_v(avg_r_left, avg_g_left, avg_b_left);
    let u_right = rgb_to_u(avg_r_right, avg_g_right, avg_b_right);
    let v_right = rgb_to_v(avg_r_right, avg_g_right, avg_b_right);

    let uv_word = u_left | (v_left << 8u) | (u_right << 16u) | (v_right << 24u);
    let uv_row = global_id.y;
    let uv_offset = y_plane_size + uv_row * params.uv_stride + px;
    let uv_idx = uv_offset / 4u;
    nv12_output[uv_idx] = uv_word;
}
