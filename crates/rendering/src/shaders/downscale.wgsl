// Two-pass cubic prefilter for layers drawn smaller than their source.
// The horizontal pass resamples each source row to the output columns, the
// vertical pass resamples those columns to the output rows. Every output
// texel lands on one output pixel, so the composite reads it 1:1.

struct Params {
    // Source texel position (centres at integers) of output texel n is
    // origin + scale * (n + 0.5) - 0.5. A negative scale mirrors.
    origin: f32,
    scale: f32,
    // Kernel stretch in source texels: the shrink factor, at least 1.
    footprint: f32,
    // First source texel row (horizontal pass) the output row 0 reads.
    row_offset: f32,
    // Inclusive source texel range taps clamp to (the crop).
    edge_min: i32,
    edge_max: i32,
    _padding: vec2<f32>,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: texture_2d<f32>;

// Beyond a 16x shrink the kernel stops widening, bounding the taps per
// pixel for a tiny camera bubble.
const MAX_FOOTPRINT: f32 = 16.0;
const RADIUS: f32 = 2.0;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    return vec4<f32>(positions[vertex_index], 0.0, 1.0);
}

// Catmull-Rom cubic: within 0.5 dB of Lanczos-2 on text at these shrink
// factors, without the per-tap sines.
fn cubic(x: f32) -> f32 {
    let ax = abs(x);
    let ax2 = ax * ax;
    if ax < 1.0 {
        return (1.5 * ax - 2.5) * ax2 + 1.0;
    }
    if ax < RADIUS {
        return ((-0.5 * ax + 2.5) * ax - 4.0) * ax + 2.0;
    }
    return 0.0;
}

// Filters along x when `horizontal`, along y otherwise. `line` is the fixed
// texel on the other axis, `n` the output texel along the filtered one.
fn filter_line(n: f32, line: i32, horizontal: bool) -> vec4<f32> {
    let center = params.origin + params.scale * (n + 0.5) - 0.5;
    let footprint = clamp(params.footprint, 1.0, MAX_FOOTPRINT);
    let inv_footprint = 1.0 / footprint;
    let reach = footprint * RADIUS;
    let first = i32(ceil(center - reach));
    let last = i32(floor(center + reach));

    var color = vec4<f32>(0.0);
    var weight_sum = 0.0;
    for (var i = first; i <= last; i = i + 1) {
        let weight = cubic((f32(i) - center) * inv_footprint);
        let tap = clamp(i, params.edge_min, params.edge_max);
        var coord = vec2<i32>(tap, line);
        if !horizontal {
            coord = vec2<i32>(line, tap);
        }
        color += textureLoad(source, coord, 0) * weight;
        weight_sum += weight;
    }
    return color / weight_sum;
}

@fragment
fn fs_horizontal(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let row = i32(position.y) + i32(params.row_offset);
    return filter_line(floor(position.x), row, true);
}

@fragment
fn fs_vertical(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let color = filter_line(floor(position.y), i32(position.x), false);
    return clamp(color, vec4<f32>(0.0), vec4<f32>(1.0));
}
