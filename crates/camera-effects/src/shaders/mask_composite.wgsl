@group(0) @binding(0) var sharp_tex: texture_2d<f32>;
@group(0) @binding(1) var blurred_tex: texture_2d<f32>;
@group(0) @binding(2) var mask_tex: texture_2d<f32>;
@group(0) @binding(3) var tex_sampler: sampler;

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

fn foreground_alpha(uv: vec2<f32>, color: vec3<f32>) -> f32 {
    let center = textureSampleLevel(mask_tex, tex_sampler, uv, 0.0).r;
    if center <= 0.01 || center >= 0.99 {
        return center;
    }
    let texel = 1.0 / vec2<f32>(textureDimensions(mask_tex));
    var total = 0.0;
    var weights = 0.0;
    for (var y = -1; y <= 1; y += 1) {
        for (var x = -1; x <= 1; x += 1) {
            let offset = vec2<f32>(f32(x), f32(y));
            let sample_uv = uv + offset * texel;
            let neighbor = textureSampleLevel(sharp_tex, tex_sampler, sample_uv, 0.0).rgb;
            let difference = neighbor - color;
            let weight = exp(-dot(difference, difference) * 40.0 - dot(offset, offset) * 0.5);
            total += textureSampleLevel(mask_tex, tex_sampler, sample_uv, 0.0).r * weight;
            weights += weight;
        }
    }
    return clamp(total / weights, 0.0, 1.0);
}

@fragment
fn fs_background(in: VertexOutput) -> @location(0) vec4<f32> {
    let sharp = textureSample(sharp_tex, tex_sampler, in.uv);
    let texel = 1.0 / vec2<f32>(textureDimensions(mask_tex));
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

fn cubic_weights(fraction: f32) -> vec4<f32> {
    let inverse = 1.0 - fraction;
    let square = fraction * fraction;
    let cube = square * fraction;
    return vec4<f32>(
        inverse * inverse * inverse,
        3.0 * cube - 6.0 * square + 4.0,
        -3.0 * cube + 3.0 * square + 3.0 * fraction + 1.0,
        cube,
    ) / 6.0;
}

fn smooth_cutout_alpha(uv: vec2<f32>) -> f32 {
    let size = vec2<f32>(textureDimensions(mask_tex));
    let position = uv * size - 0.5;
    let base = floor(position);
    let fraction = fract(position);
    let x_weights = cubic_weights(fraction.x);
    let y_weights = cubic_weights(fraction.y);
    let x_groups = x_weights.xz + x_weights.yw;
    let y_groups = y_weights.xz + y_weights.yw;
    let x = (base.x + vec2<f32>(-0.5, 1.5) + x_weights.yw / x_groups) / size.x;
    let y = (base.y + vec2<f32>(-0.5, 1.5) + y_weights.yw / y_groups) / size.y;
    let top_left = textureSampleLevel(mask_tex, tex_sampler, vec2<f32>(x.x, y.x), 0.0).r;
    let top_right = textureSampleLevel(mask_tex, tex_sampler, vec2<f32>(x.y, y.x), 0.0).r;
    let bottom_left = textureSampleLevel(mask_tex, tex_sampler, vec2<f32>(x.x, y.y), 0.0).r;
    let bottom_right = textureSampleLevel(mask_tex, tex_sampler, vec2<f32>(x.y, y.y), 0.0).r;
    let top = mix(top_left, top_right, x_groups.y);
    let bottom = mix(bottom_left, bottom_right, x_groups.y);
    return mix(top, bottom, y_groups.y);
}

@fragment
fn fs_cutout(in: VertexOutput) -> @location(0) vec4<f32> {
    let sharp = textureSample(sharp_tex, tex_sampler, in.uv);
    let alpha = clamp((smooth_cutout_alpha(in.uv) - 0.04) / 0.96, 0.0, 1.0);
    return vec4<f32>(sharp.rgb, sharp.a * alpha);
}
