@group(0) @binding(0)
var yuyv_input: texture_2d<u32>;

@group(0) @binding(1)
var rgba_output: texture_storage_2d<rgba8unorm, write>;

// We use 8x8 workgroups to cover the entire input texture
@compute
@workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(yuyv_input);
    if (gid.x >= dims.x || gid.y >= dims.y) {
        return;
    }

    // Each texel in Rgba8Uint has .r, .g, .b, .a (each 8 bits).
    // In standard YUYV: R=Y0, G=U, B=Y1, A=V. 
    // Some cameras mislabel and actually deliver YVYU or UYVY, so see below if color is off.

    let packed = textureLoad(yuyv_input, gid.xy, 0);

    // --- Standard “YUYV” interpretation (no offsets) ---
    let y0 = f32(packed.r) / 255.0;
    let v  = f32(packed.g) / 255.0;
    let y1 = f32(packed.b) / 255.0;
    let u  = f32(packed.a) / 255.0;

    // If you still see green/magenta, try swapping U<->V here:
    // let y0 = f32(packed.r) / 255.0;
    // let v  = f32(packed.g) / 255.0; // swapped
    // let y1 = f32(packed.b) / 255.0;
    // let u  = f32(packed.a) / 255.0; // swapped

    // ---- Full-Range YUV->RGB (0..255 for Y, U, V) ----
    // R = Y + 1.402 * (V - 0.5)
    // G = Y - 0.344136 * (U - 0.5) - 0.714136 * (V - 0.5)
    // B = Y + 1.772 * (U - 0.5)
    let r1 = clamp(y0 + 1.402 * (v - 0.5), 0.0, 1.0);
    let g1 = clamp(y0
        - 0.344136 * (u - 0.5)
        - 0.714136 * (v - 0.5),
        0.0, 1.0);
    let b1 = clamp(y0 + 1.772 * (u - 0.5), 0.0, 1.0);

    let r2 = clamp(y1 + 1.402 * (v - 0.5), 0.0, 1.0);
    let g2 = clamp(y1
        - 0.344136 * (u - 0.5)
        - 0.714136 * (v - 0.5),
        0.0, 1.0);
    let b2 = clamp(y1 + 1.772 * (u - 0.5), 0.0, 1.0);

    // Each texel stores two Y’s => two output RGBA pixels.
    let out_coords = gid.xy * vec2<u32>(2, 1);

    textureStore(rgba_output, out_coords, vec4<f32>(r1, g1, b1, 1.0));
    textureStore(rgba_output, out_coords + vec2<u32>(1, 0), vec4<f32>(r2, g2, b2, 1.0));
}