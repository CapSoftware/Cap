@group(0) @binding(0) var sharp_tex: texture_2d<f32>;
@group(0) @binding(1) var blurred_tex: texture_2d<f32>;
@group(0) @binding(2) var mask_tex: texture_2d<f32>;
@group(0) @binding(3) var tex_sampler: sampler;
@group(0) @binding(4) var matte_tex: texture_2d<f32>;

const MATTE_LOW: f32 = 0.25;
const MATTE_HIGH: f32 = 0.9;

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

fn cubic_bspline(t: f32) -> vec4<f32> {
    let t2 = t * t;
    let t3 = t2 * t;
    let inverse = 1.0 - t;
    return vec4<f32>(
        inverse * inverse * inverse,
        3.0 * t3 - 6.0 * t2 + 4.0,
        -3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0,
        t3,
    ) / 6.0;
}

// Cubic B-spline upsampling of the coefficients. Bilinear upsampling left
// the working grid visible as straight facets along the outline; the
// B-spline is smooth across texels. Four bilinear taps, each placed so the
// hardware filter blends a pair of texels in the B-spline's proportions.
fn matte_coefficients(uv: vec2<f32>) -> vec4<f32> {
    let size = vec2<f32>(textureDimensions(matte_tex));
    let position = uv * size - 0.5;
    let base = floor(position);
    let fraction = position - base;
    let weights_x = cubic_bspline(fraction.x);
    let weights_y = cubic_bspline(fraction.y);
    let group_x = vec2<f32>(weights_x.x + weights_x.y, weights_x.z + weights_x.w);
    let group_y = vec2<f32>(weights_y.x + weights_y.y, weights_y.z + weights_y.w);
    let x = (base.x + vec2<f32>(-0.5, 1.5) + vec2<f32>(weights_x.y, weights_x.w) / group_x) / size.x;
    let y = (base.y + vec2<f32>(-0.5, 1.5) + vec2<f32>(weights_y.y, weights_y.w) / group_y) / size.y;
    let top = textureSampleLevel(matte_tex, tex_sampler, vec2<f32>(x.x, y.x), 0.0) * group_x.x
        + textureSampleLevel(matte_tex, tex_sampler, vec2<f32>(x.y, y.x), 0.0) * group_x.y;
    let bottom = textureSampleLevel(matte_tex, tex_sampler, vec2<f32>(x.x, y.y), 0.0) * group_x.x
        + textureSampleLevel(matte_tex, tex_sampler, vec2<f32>(x.y, y.y), 0.0) * group_x.y;
    return top * group_y.x + bottom * group_y.y;
}

// Applies the guided filter at full resolution, then tightens the soft
// matte so only genuinely mixed pixels (hair, motion) stay translucent.
fn foreground_alpha(uv: vec2<f32>, color: vec3<f32>) -> f32 {
    let coefficients = matte_coefficients(uv);
    let matte = dot(coefficients.rgb, color) + coefficients.a;
    let t = clamp((matte - MATTE_LOW) / (MATTE_HIGH - MATTE_LOW), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

@fragment
fn fs_background(in: VertexOutput) -> @location(0) vec4<f32> {
    let sharp = textureSample(sharp_tex, tex_sampler, in.uv);
    // Dilate by one output texel of this downscaled pass, so the background
    // estimate stays clear of the subject whatever the mask resolution.
    let texel = fwidth(in.uv);
    var foreground = textureSample(mask_tex, tex_sampler, in.uv).r;
    foreground = max(foreground, textureSample(mask_tex, tex_sampler, in.uv + vec2<f32>(texel.x, 0.0)).r);
    foreground = max(foreground, textureSample(mask_tex, tex_sampler, in.uv - vec2<f32>(texel.x, 0.0)).r);
    foreground = max(foreground, textureSample(mask_tex, tex_sampler, in.uv + vec2<f32>(0.0, texel.y)).r);
    foreground = max(foreground, textureSample(mask_tex, tex_sampler, in.uv - vec2<f32>(0.0, texel.y)).r);
    let background = 1.0 - foreground;
    return vec4<f32>(sharp.rgb * background, background);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let sharp = textureSample(sharp_tex, tex_sampler, in.uv);
    let blurred = textureSample(blurred_tex, tex_sampler, in.uv);
    let alpha = foreground_alpha(in.uv, sharp.rgb);
    let background = select(sharp.rgb, blurred.rgb / max(blurred.a, 0.0001), blurred.a > 0.0001);
    return vec4<f32>(mix(background, sharp.rgb, alpha), sharp.a);
}

@fragment
fn fs_cutout(in: VertexOutput) -> @location(0) vec4<f32> {
    let sharp = textureSample(sharp_tex, tex_sampler, in.uv);
    let alpha = foreground_alpha(in.uv, sharp.rgb);
    // Edge pixels are a blend of the person and the room behind them.
    // Unmixing against the local background estimate (I = aF + (1 - a)B)
    // stops the old wall colour from fringing the cutout.
    let background = textureSampleLevel(blurred_tex, tex_sampler, in.uv, 0.0);
    var color = sharp.rgb;
    // The estimate is only trusted where the pixel is mostly person, and its
    // shift is capped: a wrong background guess near the face must not turn
    // into a saturated fringe.
    if alpha > 0.0 && alpha < 1.0 && background.a > 0.01 {
        let unmixed = (sharp.rgb - (1.0 - alpha) * background.rgb / background.a) / alpha;
        let shift = clamp(unmixed - sharp.rgb, vec3<f32>(-0.25), vec3<f32>(0.25));
        color = clamp(sharp.rgb + shift * smoothstep(0.2, 0.6, alpha), vec3<f32>(0.0), vec3<f32>(1.0));
    }
    return vec4<f32>(color, sharp.a * alpha);
}
