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
    // Index of the layer a `body` dispatch runs.
    layer: u32,
    _pad: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> weights: array<mat4x4<f32>>;
@group(0) @binding(2) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> input: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> features: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> readout: array<mat4x4<f32>>;
@group(0) @binding(6) var<storage, read_write> residual: array<vec4<f32>>;
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

@compute @workgroup_size(8, 8)
fn load(@builtin(global_invocation_id) id: vec3<u32>) {
    for (var k = 0; k < 2; k++) {
        let p = vec2<i32>(i32(id.x) * 2 + k, i32(id.y));
        if inside(p) {
            features[index(p)] = vec4<f32>(source_at(p), 0.0);
        }
    }
}

// Zero outside the stripe buffer: the convolutions are zero padded.
fn texel(p: vec2<i32>, groups: u32, group: u32) -> vec4<f32> {
    let clamped = clamp(p, vec2<i32>(0), vec2<i32>(params.size) - vec2<i32>(1));
    let v = input[index(clamped) * groups + group];
    return select(vec4<f32>(0.0), v, inside(p));
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
        let va = texel(neighbour(pa, tap), 1u, 0u);
        let vb = texel(neighbour(pb, tap), 1u, 0u);
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

fn store(p: vec2<i32>, f0: vec4<f32>, f1: vec4<f32>, first_layer: bool) {
    if !inside(p) {
        return;
    }
    let i = index(p);
    features[i * 2u] = f0;
    features[i * 2u + 1u] = f1;
    let w = params.layer * 4u;
    let contribution = readout[w] * max(f0, vec4<f32>(0.0)) + readout[w + 1u] * max(f1, vec4<f32>(0.0))
        + readout[w + 2u] * max(-f0, vec4<f32>(0.0)) + readout[w + 3u] * max(-f1, vec4<f32>(0.0));
    if first_layer {
        residual[i] = bias[2] + contribution;
    } else {
        residual[i] += contribution;
    }
}

// Later layers: CReLU of the previous layer in, 8 channels out; adds this
// layer's readout to the residual. Weight blocks per output group, in input
// group order (positive 0-3, positive 4-7, negative 0-3, negative 4-7).
@compute @workgroup_size(8, 8)
fn body(@builtin(global_invocation_id) id: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
    if !tile_needed(vec2<i32>(group.xy)) {
        return;
    }
    let pa = vec2<i32>(i32(id.x) * 2, i32(id.y));
    let pb = pa + vec2<i32>(1, 0);
    var a0 = bias[0];
    var a1 = bias[1];
    var b0 = bias[0];
    var b1 = bias[1];
    let zero = vec4<f32>(0.0);
    for (var tap = 0u; tap < 9u; tap++) {
        let qa = neighbour(pa, tap);
        let qb = neighbour(pb, tap);
        let xa0 = texel(qa, 2u, 0u);
        let xa1 = texel(qa, 2u, 1u);
        let xb0 = texel(qb, 2u, 0u);
        let xb1 = texel(qb, 2u, 1u);
        let pa0 = max(xa0, zero);
        let pa1 = max(xa1, zero);
        let na0 = max(-xa0, zero);
        let na1 = max(-xa1, zero);
        let pb0 = max(xb0, zero);
        let pb1 = max(xb1, zero);
        let nb0 = max(-xb0, zero);
        let nb1 = max(-xb1, zero);
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
    store(pa, a0, a1, false);
    store(pb, b0, b1, false);
}

fn loaded(p: vec2<i32>) -> vec3<f32> {
    return input[index(clamp(p, vec2<i32>(0), vec2<i32>(params.size) - vec2<i32>(1)))].rgb;
}

// Bilinear 2x base plus the residual, clamped to the four texels each
// sub-pixel's bilinear sample reads. `input` holds the loaded source here.
@compute @workgroup_size(8, 8)
fn finish(@builtin(global_invocation_id) id: vec3<u32>, @builtin(workgroup_id) group: vec3<u32>) {
    let flat = tile_flat(vec2<i32>(group.xy));
    for (var k = 0; k < 2; k++) {
        let p = vec2<i32>(i32(id.x) * 2 + k, i32(id.y));
        if !inside(p) || u32(p.y) < params.write_rows.x || u32(p.y) >= params.write_rows.y {
            continue;
        }
        let r = select(residual[index(p)], vec4<f32>(0.0), flat);
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
}
