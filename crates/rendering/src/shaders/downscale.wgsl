// Two-pass Lanczos prefilter for layers drawn smaller than their source.
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
    // Lanczos lobes on each side of the centre.
    radius: f32,
    _padding: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: texture_2d<f32>;

// Beyond a 16x shrink the kernel stops widening, bounding the taps per
// pixel for a tiny camera bubble.
const MAX_FOOTPRINT: f32 = 16.0;
const PI: f32 = 3.141592653589793;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    return vec4<f32>(positions[vertex_index], 0.0, 1.0);
}

// Filters along x when `horizontal`, along y otherwise. `line` is the fixed
// texel on the other axis, `n` the output texel along the filtered one.
// The Lanczos weight at x is radius * sin(pi x) * sin(pi x / radius) /
// (pi x)^2; taps sit 1 / footprint apart in x, so both sines advance by a
// fixed rotation per tap instead of being evaluated each time.
fn filter_line(n: f32, line: i32, horizontal: bool) -> vec4<f32> {
    let center = params.origin + params.scale * (n + 0.5) - 0.5;
    let footprint = clamp(params.footprint, 1.0, MAX_FOOTPRINT);
    let radius = params.radius;
    let reach = footprint * radius;
    let first = i32(ceil(center - reach));
    let last = i32(floor(center + reach));

    let step = PI / footprint;
    let step_sin = vec2<f32>(sin(step), sin(step / radius));
    let step_cos = vec2<f32>(cos(step), cos(step / radius));
    let angle0 = PI * (f32(first) - center) / footprint;
    var sines = vec2<f32>(sin(angle0), sin(angle0 / radius));
    var cosines = vec2<f32>(cos(angle0), cos(angle0 / radius));

    var color = vec4<f32>(0.0);
    var weight_sum = 0.0;
    for (var i = first; i <= last; i = i + 1) {
        let angle = angle0 + f32(i - first) * step;
        var weight = 1.0;
        if abs(angle) > 1e-4 {
            weight = radius * sines.x * sines.y / (angle * angle);
        }
        let tap = clamp(i, params.edge_min, params.edge_max);
        var coord = vec2<i32>(tap, line);
        if !horizontal {
            coord = vec2<i32>(line, tap);
        }
        color += textureLoad(source, coord, 0) * weight;
        weight_sum += weight;
        let next = sines * step_cos + cosines * step_sin;
        cosines = cosines * step_cos - sines * step_sin;
        sines = next;
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
