// A 2x upscaler for screen content, run as compute passes over one
// horizontal stripe of the source at a time.
//
// Trunk: 3x3 convolutions with 8 channels. Every layer after the first reads
// its input as (max(x, 0), max(-x, 0)), 16 channels. A 1x1 readout over all
// layers' outputs, read the same way, gives one residual per 2x2 output
// sub-pixel; it is added equally to R, G and B on top of a bilinear 2x
// upscale, then clamped to the range of the four texels that bilinear
// sample reads.
//
// The arithmetic is f32; features and the residual are stored as f16 to
// halve the memory traffic between layers. The last layer adds its readout
// and writes the output in the same pass.
//
// Each thread handles two horizontally adjacent texels, so a workgroup covers
// a 16x8 tile. Tiles whose source (with the trunk's reach around them) is
// flat skip the trunk and keep the bilinear result.

struct Params {
    size: vec2<u32>,
    source_origin: vec2<i32>,
    source_max: vec2<i32>,
    write_rows: vec2<u32>,
    out_origin: vec2<i32>,
    tiles: vec2<u32>,
    // Source range (in unorm) at or below which a tile counts as flat.
    flat_range: f32,
    // Texels the trunk reads around a tile.
    reach: i32,
    // Index of the layer a dispatch runs.
    layer: u32,
    _pad: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> weights: array<mat4x4<f32>>;
@group(0) @binding(2) var<storage, read> bias: array<vec4<f32>>;
// Eight f16 features per texel.
@group(0) @binding(3) var<storage, read> input: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> features: array<vec4<u32>>;
@group(0) @binding(5) var<storage, read> readout: array<mat4x4<f32>>;
// Four f16 sub-pixel residuals per texel.
@group(0) @binding(6) var<storage, read_write> residual: array<vec2<u32>>;
@group(0) @binding(7) var<storage, read_write> flat_tiles: array<u32>;

@group(1) @binding(0) var source: texture_2d<f32>;
@group(1) @binding(1) var upscaled: texture_storage_2d<rgba8unorm, write>;

const TILE = vec2<i32>(16, 8);

var<workgroup> tile_min: array<vec3<f32>, 64>;
var<workgroup> tile_max: array<vec3<f32>, 64>;

fn inside(p: vec2<i32>) -> bool {
    return all(p >= vec2<i32>(0)) && all(p < vec2<i32>(params.size));
}

fn index(p: vec2<i32>) -> u32 {
    return u32(p.y) * params.size.x + u32(p.x);
}

fn neighbour(p: vec2<i32>, tap: u32) -> vec2<i32> {
    return p + vec2<i32>(i32(tap % 3u) - 1, i32(tap / 3u) - 1);
}

fn tile_flat(tile: vec2<i32>) -> bool {
    if any(tile < vec2<i32>(0)) || any(tile >= vec2<i32>(params.tiles)) {
        return true;
    }
    return flat_tiles[u32(tile.y) * params.tiles.x + u32(tile.x)] != 0u;
}

// A tile's trunk features are needed when it, or a tile whose reach covers
// it, is not flat.
fn tile_needed(tile: vec2<i32>) -> bool {
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            if !tile_flat(tile + vec2<i32>(dx, dy)) {
                return true;
            }
        }
    }
    return false;
}

fn source_at(p: vec2<i32>) -> vec3<f32> {
    return textureLoad(source, clamp(params.source_origin + p, vec2<i32>(0), params.source_max), 0).rgb;
}

@compute @workgroup_size(8, 8)
fn classify(
    @builtin(workgroup_id) group: vec3<u32>,
    @builtin(local_invocation_index) lane: u32,
) {
    let origin = vec2<i32>(group.xy) * TILE - vec2<i32>(params.reach);
    let span = TILE + vec2<i32>(2 * params.reach);
    var lo = vec3<f32>(1.0);
    var hi = vec3<f32>(0.0);
    for (var i = i32(lane); i < span.x * span.y; i += 64) {
        let p = origin + vec2<i32>(i % span.x, i / span.x);
        let c = source_at(clamp(p, vec2<i32>(0), vec2<i32>(params.size) - vec2<i32>(1)));
        lo = min(lo, c);
        hi = max(hi, c);
    }
    tile_min[lane] = lo;
    tile_max[lane] = hi;
    workgroupBarrier();
    for (var stride = 32u; stride > 0u; stride >>= 1u) {
        if lane < stride {
            tile_min[lane] = min(tile_min[lane], tile_min[lane + stride]);
            tile_max[lane] = max(tile_max[lane], tile_max[lane + stride]);
        }
        workgroupBarrier();
    }
    if lane == 0u && all(group.xy < params.tiles) {
        let range = tile_max[0] - tile_min[0];
        flat_tiles[group.y * params.tiles.x + group.x] =
            select(0u, 1u, max(max(range.x, range.y), range.z) <= params.flat_range);
    }
}

// Zero outside the stripe: the convolutions are zero padded.
fn rgb(p: vec2<i32>) -> vec4<f32> {
    return select(vec4<f32>(0.0), vec4<f32>(source_at(p), 0.0), inside(p));
}

struct Pair {
    lo: vec4<f32>,
    hi: vec4<f32>,
};

fn unpack(v: vec4<u32>) -> Pair {
    let a = unpack2x16float(v.x);
    let b = unpack2x16float(v.y);
    let c = unpack2x16float(v.z);
    let d = unpack2x16float(v.w);
    return Pair(vec4<f32>(a, b), vec4<f32>(c, d));
}

fn pack(f0: vec4<f32>, f1: vec4<f32>) -> vec4<u32> {
    return vec4<u32>(pack2x16float(f0.xy), pack2x16float(f0.zw), pack2x16float(f1.xy), pack2x16float(f1.zw));
}

fn feature(p: vec2<i32>) -> Pair {
    let clamped = clamp(p, vec2<i32>(0), vec2<i32>(params.size) - vec2<i32>(1));
    let v = select(vec4<u32>(0u), input[index(clamped)], inside(p));
    return unpack(v);
}

fn load_residual(i: u32) -> vec4<f32> {
    let v = residual[i];
    return vec4<f32>(unpack2x16float(v.x), unpack2x16float(v.y));
}

fn store_residual(i: u32, r: vec4<f32>) {
    residual[i] = vec2<u32>(pack2x16float(r.xy), pack2x16float(r.zw));
}

// First layer: raw RGB in, 8 channels out; starts the residual with the
// readout bias and this layer's readout.
@compute @workgroup_size(8, 8)
fn first(@builtin(global_invocation_id) id: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
    if !tile_needed(vec2<i32>(group.xy)) {
        return;
    }
    let pa = vec2<i32>(i32(id.x) * 2, i32(id.y));
    let pb = pa + vec2<i32>(1, 0);
    var a0 = bias[0];
    var a1 = bias[1];
    var b0 = bias[0];
    var b1 = bias[1];
    for (var tap = 0u; tap < 9u; tap++) {
        let va = rgb(neighbour(pa, tap));
        let vb = rgb(neighbour(pb, tap));
        let w0 = weights[tap];
        let w1 = weights[9u + tap];
        a0 += w0 * va;
        b0 += w0 * vb;
        a1 += w1 * va;
        b1 += w1 * vb;
    }
    store(pa, a0, a1, true);
    store(pb, b0, b1, true);
}

fn readout_of(f0: vec4<f32>, f1: vec4<f32>) -> vec4<f32> {
    let w = params.layer * 4u;
    return readout[w] * max(f0, vec4<f32>(0.0)) + readout[w + 1u] * max(f1, vec4<f32>(0.0))
        + readout[w + 2u] * max(-f0, vec4<f32>(0.0)) + readout[w + 3u] * max(-f1, vec4<f32>(0.0));
}

fn store(p: vec2<i32>, f0: vec4<f32>, f1: vec4<f32>, first_layer: bool) {
    if !inside(p) {
        return;
    }
    let i = index(p);
    features[i] = pack(f0, f1);
    let contribution = readout_of(f0, f1);
    if first_layer {
        store_residual(i, bias[2] + contribution);
    } else {
        store_residual(i, load_residual(i) + contribution);
    }
}

struct Quad {
    a0: vec4<f32>,
    a1: vec4<f32>,
    b0: vec4<f32>,
    b1: vec4<f32>,
};

// One later layer at two texels: CReLU of the previous layer in, 8 channels
// out. Weight blocks per output group, in input group order (positive 0-3,
// positive 4-7, negative 0-3, negative 4-7).
fn conv(pa: vec2<i32>, pb: vec2<i32>) -> Quad {
    var a0 = bias[0];
    var a1 = bias[1];
    var b0 = bias[0];
    var b1 = bias[1];
    let zero = vec4<f32>(0.0);
    for (var tap = 0u; tap < 9u; tap++) {
        let fa = feature(neighbour(pa, tap));
        let fb = feature(neighbour(pb, tap));
        let pa0 = max(fa.lo, zero);
        let pa1 = max(fa.hi, zero);
        let na0 = max(-fa.lo, zero);
        let na1 = max(-fa.hi, zero);
        let pb0 = max(fb.lo, zero);
        let pb1 = max(fb.hi, zero);
        let nb0 = max(-fb.lo, zero);
        let nb1 = max(-fb.hi, zero);
        var w = weights[tap];
        a0 += w * pa0;
        b0 += w * pb0;
        w = weights[9u + tap];
        a0 += w * pa1;
        b0 += w * pb1;
        w = weights[18u + tap];
        a0 += w * na0;
        b0 += w * nb0;
        w = weights[27u + tap];
        a0 += w * na1;
        b0 += w * nb1;
        w = weights[36u + tap];
        a1 += w * pa0;
        b1 += w * pb0;
        w = weights[45u + tap];
        a1 += w * pa1;
        b1 += w * pb1;
        w = weights[54u + tap];
        a1 += w * na0;
        b1 += w * nb0;
        w = weights[63u + tap];
        a1 += w * na1;
        b1 += w * nb1;
    }
    return Quad(a0, a1, b0, b1);
}

@compute @workgroup_size(8, 8)
fn body(@builtin(global_invocation_id) id: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
    if !tile_needed(vec2<i32>(group.xy)) {
        return;
    }
    let pa = vec2<i32>(i32(id.x) * 2, i32(id.y));
    let pb = pa + vec2<i32>(1, 0);
    let q = conv(pa, pb);
    store(pa, q.a0, q.a1, false);
    store(pb, q.b0, q.b1, false);
}



fn loaded(p: vec2<i32>) -> vec3<f32> {
    return source_at(clamp(p, vec2<i32>(0), vec2<i32>(params.size) - vec2<i32>(1)));
}

// Bilinear 2x base plus the residual, clamped to the four texels each
// sub-pixel's bilinear sample reads.
fn finish_pixel(p: vec2<i32>, r: vec4<f32>) {
    if !inside(p) || u32(p.y) < params.write_rows.x || u32(p.y) >= params.write_rows.y {
        return;
    }
    let c = loaded(p);
    let left = loaded(p + vec2<i32>(-1, 0));
    let right = loaded(p + vec2<i32>(1, 0));
    let top = loaded(p + vec2<i32>(0, -1));
    let bottom = loaded(p + vec2<i32>(0, 1));
    let corners = array<vec3<f32>, 4>(
        loaded(p + vec2<i32>(-1, -1)),
        loaded(p + vec2<i32>(1, -1)),
        loaded(p + vec2<i32>(-1, 1)),
        loaded(p + vec2<i32>(1, 1)),
    );
    let sides_x = array<vec3<f32>, 4>(left, right, left, right);
    let sides_y = array<vec3<f32>, 4>(top, top, bottom, bottom);
    let origin = 2 * (params.out_origin + p);
    for (var s = 0u; s < 4u; s++) {
        let base = 0.5625 * c + 0.1875 * (sides_x[s] + sides_y[s]) + 0.0625 * corners[s];
        let lo = min(min(c, sides_x[s]), min(sides_y[s], corners[s]));
        let hi = max(max(c, sides_x[s]), max(sides_y[s], corners[s]));
        let color = clamp(base + vec3<f32>(r[s]), lo, hi);
        textureStore(upscaled, origin + vec2<i32>(i32(s & 1u), i32(s >> 1u)), vec4<f32>(color, 1.0));
    }
}

// The last layer's features are only read by its own readout, so they are
// never stored. Flat tiles keep the bilinear result.
@compute @workgroup_size(8, 8)
fn last(@builtin(global_invocation_id) id: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
    let pa = vec2<i32>(i32(id.x) * 2, i32(id.y));
    let pb = pa + vec2<i32>(1, 0);
    var ra = vec4<f32>(0.0);
    var rb = vec4<f32>(0.0);
    if !tile_flat(vec2<i32>(group.xy)) {
        let q = conv(pa, pb);
        if inside(pa) {
            ra = load_residual(index(pa)) + readout_of(q.a0, q.a1);
        }
        if inside(pb) {
            rb = load_residual(index(pb)) + readout_of(q.b0, q.b1);
        }
    }
    finish_pixel(pa, ra);
    finish_pixel(pb, rb);
}
