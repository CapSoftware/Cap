@group(0) @binding(0) var yuyv_input: texture_2d<u32>;

@group(0) @binding(1) var<storage, read_write> y_plane: array<u32>;
@group(0) @binding(2) var<storage, read_write> uv_plane: array<u32>;

@group(0) @binding(3) var<uniform> dimensions: vec2<u32>;

@compute
@workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let dims = textureDimensions(yuyv_input);
    if (global_id.x >= dims.x || global_id.y >= dims.y) {
        return;
    }

    let yuyv = textureLoad(yuyv_input, global_id.xy, 0).rgba;

    let y0 = yuyv.r;
    let u = yuyv.g;
    let y1 = yuyv.b;
    let v = yuyv.a;

    let width = dimensions.x;
    let x = global_id.x;
    let y = global_id.y;

    let y_base = y * width + x * 2u;
    y_plane[y_base] = y0;
    y_plane[y_base + 1u] = y1;

    if ((y & 1u) == 0u) {
        let uv_row = y / 2u;
        let uv_base = uv_row * width + x * 2u;
        uv_plane[uv_base] = u;
        uv_plane[uv_base + 1u] = v;
    }
}
