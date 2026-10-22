// Colour guided filter (He et al.) that snaps the low resolution person mask
// to the camera image's real edges. Coefficients are solved at a reduced
// working resolution; the composite applies them to the full resolution
// frame, which is what makes hair and shoulders crisp instead of a smeared
// upscale of the segmentation mask.

@group(0) @binding(0) var source_tex: texture_2d<f32>;
@group(0) @binding(1) var mask_tex: texture_2d<f32>;
@group(0) @binding(2) var linear_sampler: sampler;

const RADIUS: i32 = 3;
const EPSILON: f32 = 0.0001;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    var uvs = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0),
    );
    var out: VertexOutput;
    out.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
    out.uv = uvs[vertex_index];
    return out;
}

// Downscales the camera frame into the guide and resamples the mask into
// its alpha, so the window loops below read one texel per tap. Four
// bilinear taps cover a 4x4 source footprint, so 2-4x reductions average
// instead of alias.
@fragment
fn fs_guide(in: VertexOutput) -> @location(0) vec4<f32> {
    let texel = fwidth(in.uv) * 0.25;
    var color = textureSampleLevel(source_tex, linear_sampler, in.uv + vec2<f32>(-texel.x, -texel.y), 0.0).rgb;
    color += textureSampleLevel(source_tex, linear_sampler, in.uv + vec2<f32>(texel.x, -texel.y), 0.0).rgb;
    color += textureSampleLevel(source_tex, linear_sampler, in.uv + vec2<f32>(-texel.x, texel.y), 0.0).rgb;
    color += textureSampleLevel(source_tex, linear_sampler, in.uv + vec2<f32>(texel.x, texel.y), 0.0).rgb;
    let mask = textureSampleLevel(mask_tex, linear_sampler, in.uv, 0.0).r;
    return vec4<f32>(color * 0.25, mask);
}

// Solves a = (Sigma + eps I)^-1 cov(I, p), b = mean(p) - a . mean(I) over a
// (2r + 1)^2 window. Moments are accumulated in f32 registers rather than
// stored, so variance never suffers half-float cancellation.
@fragment
fn fs_coefficients(in: VertexOutput) -> @location(0) vec4<f32> {
    let size = vec2<i32>(textureDimensions(source_tex));
    let center = vec2<i32>(in.position.xy);
    var sum_color = vec3<f32>(0.0);
    var sum_mask = 0.0;
    var sum_squares = vec3<f32>(0.0);
    var sum_cross = vec3<f32>(0.0);
    var sum_color_mask = vec3<f32>(0.0);
    for (var y = -RADIUS; y <= RADIUS; y += 1) {
        for (var x = -RADIUS; x <= RADIUS; x += 1) {
            let texel = textureLoad(source_tex, clamp(center + vec2<i32>(x, y), vec2<i32>(0), size - 1), 0);
            let color = texel.rgb;
            let mask = texel.a;
            sum_color += color;
            sum_mask += mask;
            sum_squares += color * color;
            sum_cross += color.rrg * color.gbb;
            sum_color_mask += color * mask;
        }
    }
    let count = f32((2 * RADIUS + 1) * (2 * RADIUS + 1));
    let mean_color = sum_color / count;
    let mean_mask = sum_mask / count;
    let variance = sum_squares / count - mean_color * mean_color + EPSILON;
    let covariance = sum_cross / count - mean_color.rrg * mean_color.gbb;
    let color_mask = sum_color_mask / count - mean_color * mean_mask;

    // Symmetric 3x3 inverse via cofactors.
    let rr = variance.x;
    let gg = variance.y;
    let bb = variance.z;
    let rg = covariance.x;
    let rb = covariance.y;
    let gb = covariance.z;
    let c_rr = gg * bb - gb * gb;
    let c_rg = rb * gb - rg * bb;
    let c_rb = rg * gb - rb * gg;
    let c_gg = rr * bb - rb * rb;
    let c_gb = rb * rg - rr * gb;
    let c_bb = rr * gg - rg * rg;
    let determinant = rr * c_rr + rg * c_rg + rb * c_rb;
    let a = vec3<f32>(
        c_rr * color_mask.x + c_rg * color_mask.y + c_rb * color_mask.z,
        c_rg * color_mask.x + c_gg * color_mask.y + c_gb * color_mask.z,
        c_rb * color_mask.x + c_gb * color_mask.y + c_bb * color_mask.z,
    ) / determinant;
    return vec4<f32>(a, mean_mask - dot(a, mean_color));
}

// Box-averages the coefficients so every output pixel blends all windows
// that cover it, the second half of the guided filter. Separable: one
// horizontal and one vertical pass.
fn smooth_along(position: vec4<f32>, step: vec2<i32>) -> vec4<f32> {
    let size = vec2<i32>(textureDimensions(source_tex));
    let center = vec2<i32>(position.xy);
    var sum = vec4<f32>(0.0);
    for (var i = -RADIUS; i <= RADIUS; i += 1) {
        sum += textureLoad(source_tex, clamp(center + step * i, vec2<i32>(0), size - 1), 0);
    }
    return sum / f32(2 * RADIUS + 1);
}

@fragment
fn fs_smooth_horizontal(in: VertexOutput) -> @location(0) vec4<f32> {
    return smooth_along(in.position, vec2<i32>(1, 0));
}

@fragment
fn fs_smooth_vertical(in: VertexOutput) -> @location(0) vec4<f32> {
    return smooth_along(in.position, vec2<i32>(0, 1));
}
