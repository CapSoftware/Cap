// Text-line detector (TinyDet, 1/2-res head) as WGSL compute kernels.
// Activations are CHW tensors stored in groups of 4 consecutive pixels (one storage element = 4 values): vec4<f32> in
// f32 mode, vec2<u32> holding 4 packed f16 values (pack2x16float) in f16 mode. The host prepends the storage type alias
// V4 and the ld*/st* accessor functions for the chosen precision. Math is always f32.
// Every kernel writes whole 4-pixel groups, so tile widths at every level must be multiples of 4 (tile width % 64 == 0).

struct P {
    cin_a: u32, cin_b: u32, cin_c: u32, cout: u32,
    in_w: u32, in_h: u32, out_w: u32, out_h: u32,
    w_off: u32, b_off: u32, stride: u32, flags: u32,
    u_shift: u32, b_shift: u32, c_shift: u32, cout8: u32,
    src_x: u32, src_y: u32, src_w: u32, src_h: u32,
};

const RELU: u32 = 1u;
const SIGMOID: u32 = 2u;
const HAS_U: u32 = 4u;
const U_BILINEAR: u32 = 8u;
const HAS_R: u32 = 16u;
const BGR: u32 = 32u;

@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> src_a: array<V4>;
@group(0) @binding(2) var<storage, read> src_b: array<V4>;
@group(0) @binding(3) var<storage, read> src_c: array<V4>;
@group(0) @binding(4) var<storage, read> add_u: array<V4>;
@group(0) @binding(5) var<storage, read> res_r: array<V4>;
@group(0) @binding(7) var<storage, read_write> dst: array<V4>;
@group(0) @binding(8) var src_tex: texture_2d<f32>;
@group(0) @binding(9) var<storage, read> w4: array<vec4<f32>>;
@group(0) @binding(10) var<storage, read_write> prob: array<vec4<f32>>;

// depthwise (scalar) weights live in the same buffer as the vec4 weights (8 storage buffers max per stage by default)
fn wsc(i: u32) -> f32 { return w4[i >> 2u][i & 3u]; }

// ---------------------------------------------------------------- 1x1 conv, 4 pixels x 8 output channels per invocation
fn fma8(acc: ptr<function, array<vec4<f32>, 8>>, v: vec4<f32>, w0: vec4<f32>, w1: vec4<f32>) {
    (*acc)[0] += v * w0.x;
    (*acc)[1] += v * w0.y;
    (*acc)[2] += v * w0.z;
    (*acc)[3] += v * w0.w;
    (*acc)[4] += v * w1.x;
    (*acc)[5] += v * w1.y;
    (*acc)[6] += v * w1.z;
    (*acc)[7] += v * w1.w;
}

fn near4(which: u32, c: u32, shift: u32, x: u32, y: u32) -> vec4<f32> {
    // 4 consecutive output pixels (x..x+3, y) sampled nearest from a 2^shift lower-res map
    let sw = p.out_w >> shift;
    let base = c * sw * (p.out_h >> shift) + (y >> shift) * sw;
    let i0 = base + (x >> shift);
    let i1 = base + ((x + 1u) >> shift);
    let i2 = base + ((x + 2u) >> shift);
    let i3 = base + ((x + 3u) >> shift);
    if which == 0u { return vec4<f32>(ld1_src_b(i0), ld1_src_b(i1), ld1_src_b(i2), ld1_src_b(i3)); }
    if which == 1u { return vec4<f32>(ld1_src_c(i0), ld1_src_c(i1), ld1_src_c(i2), ld1_src_c(i3)); }
    return vec4<f32>(ld1_add_u(i0), ld1_add_u(i1), ld1_add_u(i2), ld1_add_u(i3));
}

fn bil(c: u32, xo: u32, y: u32) -> f32 {
    // x2 bilinear, align_corners = false, from add_u at half the output resolution
    let uw = p.out_w >> 1u;
    let uh = p.out_h >> 1u;
    let sx = max((f32(xo) + 0.5) * 0.5 - 0.5, 0.0);
    let sy = max((f32(y) + 0.5) * 0.5 - 0.5, 0.0);
    let x0 = u32(sx);
    let y0 = u32(sy);
    let x1 = min(x0 + 1u, uw - 1u);
    let y1 = min(y0 + 1u, uh - 1u);
    let fx = sx - f32(x0);
    let fy = sy - f32(y0);
    let b = c * uw * uh;
    let a0 = mix(ld1_add_u(b + y0 * uw + x0), ld1_add_u(b + y0 * uw + x1), fx);
    let a1 = mix(ld1_add_u(b + y1 * uw + x0), ld1_add_u(b + y1 * uw + x1), fx);
    return mix(a0, a1, fy);
}

@compute @workgroup_size(64)
fn pw4(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n4 = (p.out_w * p.out_h) / 4u;
    let q = gid.x;
    if q >= n4 { return; }
    let g = gid.y;
    let pix = q * 4u;
    let x = pix % p.out_w;
    let y = pix / p.out_w;
    let c4 = p.cout8 / 4u;
    var acc: array<vec4<f32>, 8>;
    let b0 = w4[p.b_off + g * 2u];
    let b1 = w4[p.b_off + g * 2u + 1u];
    acc[0] = vec4<f32>(b0.x);
    acc[1] = vec4<f32>(b0.y);
    acc[2] = vec4<f32>(b0.z);
    acc[3] = vec4<f32>(b0.w);
    acc[4] = vec4<f32>(b1.x);
    acc[5] = vec4<f32>(b1.y);
    acc[6] = vec4<f32>(b1.z);
    acc[7] = vec4<f32>(b1.w);
    var wi = p.w_off + g * 2u;
    for (var ci = 0u; ci < p.cin_a; ci++) {
        fma8(&acc, ld4_src_a(ci * n4 + q), w4[wi], w4[wi + 1u]);
        wi += c4;
    }
    for (var ci = 0u; ci < p.cin_b; ci++) {
        fma8(&acc, near4(0u, ci, p.b_shift, x, y), w4[wi], w4[wi + 1u]);
        wi += c4;
    }
    for (var ci = 0u; ci < p.cin_c; ci++) {
        fma8(&acc, near4(1u, ci, p.c_shift, x, y), w4[wi], w4[wi + 1u]);
        wi += c4;
    }
    for (var j = 0u; j < 8u; j++) {
        let co = g * 8u + j;
        if co >= p.cout { break; }
        var v = acc[j];
        if (p.flags & HAS_U) != 0u {
            if (p.flags & U_BILINEAR) != 0u {
                v += vec4<f32>(bil(co, x, y), bil(co, x + 1u, y), bil(co, x + 2u, y), bil(co, x + 3u, y));
            } else {
                v += near4(2u, co, p.u_shift, x, y);
            }
        }
        if (p.flags & HAS_R) != 0u { v += ld4_res_r(co * n4 + q); }
        if (p.flags & RELU) != 0u { v = max(v, vec4<f32>(0.0)); }
        if (p.flags & SIGMOID) != 0u { v = 1.0 / (1.0 + exp(-v)); }
        st4_dst(co * n4 + q, v);
    }
}

// ---------------------------------------------------------------- depthwise 3x3 (stride 1 or 2), 4 output pixels of one channel
@compute @workgroup_size(64)
fn dw4(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n = p.out_w * p.out_h;
    let q = gid.x;
    if q * 4u >= n { return; }
    let c = gid.y;
    let pix = q * 4u;
    let ox = pix % p.out_w;
    let oy = pix / p.out_w;
    let W = p.in_w;
    let nin = p.in_w * p.in_h;
    var acc = vec4<f32>(wsc(p.b_off + c));
    for (var ky = 0u; ky < 3u; ky++) {
        let iy = i32(oy * p.stride + ky) - 1;
        if iy < 0 || iy >= i32(p.in_h) { continue; }
        let row = c * nin + u32(iy) * W;
        let wb = p.w_off + c * 9u + ky * 3u;
        let w0 = wsc(wb);
        let w1 = wsc(wb + 1u);
        let w2 = wsc(wb + 2u);
        if p.stride == 1u {
            var v: array<f32, 6>;
            for (var k = 0u; k < 6u; k++) {
                let ix = i32(ox + k) - 1;
                v[k] = select(0.0, ld1_src_a(row + u32(clamp(ix, 0, i32(W) - 1))), ix >= 0 && ix < i32(W));
            }
            acc += vec4<f32>(v[0], v[1], v[2], v[3]) * w0 + vec4<f32>(v[1], v[2], v[3], v[4]) * w1 + vec4<f32>(v[2], v[3], v[4], v[5]) * w2;
        } else {
            // stride 2: output pixels ox..ox+3 read input columns 2*ox-1 .. 2*ox+7
            var v: array<f32, 9>;
            for (var k = 0u; k < 9u; k++) {
                let ix = i32(ox * 2u + k) - 1;
                v[k] = select(0.0, ld1_src_a(row + u32(clamp(ix, 0, i32(W) - 1))), ix >= 0 && ix < i32(W));
            }
            acc += vec4<f32>(v[0], v[2], v[4], v[6]) * w0 + vec4<f32>(v[1], v[3], v[5], v[7]) * w1 + vec4<f32>(v[2], v[4], v[6], v[8]) * w2;
        }
    }
    if (p.flags & RELU) != 0u { acc = max(acc, vec4<f32>(0.0)); }
    st4_dst((c * n + pix) / 4u, acc);
}

// ---------------------------------------------------------------- stem: 3x3 stride 2 on the source texture ROI
// 4 output pixels x 16 channels per invocation. Normalisation fused. Pixels outside the ROI tile or the source texture
// contribute 0 (the conv's zero padding of the normalised input). w4[w_off + (k * 3 + ci) * 4 + j] = channels 4j..4j+3.
@compute @workgroup_size(64)
fn stem4(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n4 = (p.out_w * p.out_h) / 4u;
    let q = gid.x;
    if q >= n4 { return; }
    let pix = q * 4u;
    let ox = pix % p.out_w;
    let oy = pix / p.out_w;
    let mean = vec3<f32>(0.485, 0.456, 0.406);
    let inv_std = vec3<f32>(1.0 / 0.229, 1.0 / 0.224, 1.0 / 0.225);
    var acc: array<vec4<f32>, 16>;
    for (var j = 0u; j < 4u; j++) {
        let b = w4[p.b_off + j];
        acc[j * 4u] = vec4<f32>(b.x);
        acc[j * 4u + 1u] = vec4<f32>(b.y);
        acc[j * 4u + 2u] = vec4<f32>(b.z);
        acc[j * 4u + 3u] = vec4<f32>(b.w);
    }
    for (var ky = 0u; ky < 3u; ky++) {
        let iy = i32(oy * 2u + ky) - 1;
        let sy = i32(p.src_y) + iy;
        let row_ok = iy >= 0 && iy < i32(p.in_h) && sy < i32(p.src_h);
        for (var kx = 0u; kx < 3u; kx++) {
            var px: array<vec3<f32>, 4>;
            for (var t = 0u; t < 4u; t++) {
                let ix = i32((ox + t) * 2u + kx) - 1;
                let sx = i32(p.src_x) + ix;
                if row_ok && ix >= 0 && ix < i32(p.in_w) && sx < i32(p.src_w) {
                    var c = textureLoad(src_tex, vec2<i32>(sx, sy), 0).xyz;
                    if (p.flags & BGR) != 0u { c = c.zyx; }
                    px[t] = (c - mean) * inv_std;
                } else {
                    px[t] = vec3<f32>(0.0);
                }
            }
            let k = ky * 3u + kx;
            for (var ci = 0u; ci < 3u; ci++) {
                let v = vec4<f32>(px[0][ci], px[1][ci], px[2][ci], px[3][ci]);
                let wb = p.w_off + (k * 3u + ci) * 4u;
                for (var j = 0u; j < 4u; j++) {
                    let w = w4[wb + j];
                    acc[j * 4u] += v * w.x;
                    acc[j * 4u + 1u] += v * w.y;
                    acc[j * 4u + 2u] += v * w.z;
                    acc[j * 4u + 3u] += v * w.w;
                }
            }
        }
    }
    for (var co = 0u; co < 16u; co++) {
        st4_dst(co * n4 + q, max(acc[co], vec4<f32>(0.0)));
    }
}

// ---------------------------------------------------------------- final map to f32 (prob buffer read by the host)
@compute @workgroup_size(64)
fn to_f32(@builtin(global_invocation_id) gid: vec3<u32>) {
    let n4 = (p.out_w * p.out_h) / 4u;
    if gid.x >= n4 { return; }
    prob[gid.x] = ld4_src_a(gid.x);
}
