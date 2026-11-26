struct EnhanceUniforms {
    // Source texture size in texels.
    frame_size: vec2<f32>,
    // Output-space origin of the upscale region; texel (0, 0) of the region
    // texture is the output pixel at this origin.
    region_origin: vec2<f32>,
    target_origin: vec2<f32>,
    target_size: vec2<f32>,
    crop_min: vec2<f32>,
    crop_max: vec2<f32>,
    // (threshold in unorm, iterations, radius in texels, network output flag).
    deband: vec4<f32>,
    // (RCAS contrast scale, mirror_x, region width, region height).
    params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: EnhanceUniforms;
@group(0) @binding(1) var source_texture: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    return vec4<f32>(positions[vertex_index], 0.0, 1.0);
}

// Deband runs in integers so every GPU makes the same choices: a float hash or
// cos/sin differs between drivers, moves a tap by a texel beside text and
// flips whether the pixel is averaged, which the upscale then amplifies.
fn hash_u32(value: u32) -> u32 {
    var h = value;
    h ^= h >> 16u;
    h *= 0x7feb352du;
    h ^= h >> 15u;
    h *= 0x846ca68bu;
    h ^= h >> 16u;
    return h;
}

// Ordered dither in 1/256 of an 8-bit level, within +-0.5 level.
fn bayer8(p: vec2<u32>) -> i32 {
    let x = p.x & 7u;
    let y = p.y & 7u;
    let xy = x ^ y;
    let v = ((xy & 1u) << 5u) | ((x & 1u) << 4u) | ((xy & 2u) << 2u) | ((x & 2u) << 1u)
        | ((xy & 4u) >> 1u) | ((x & 4u) >> 2u);
    return i32(v) * 4 + 2 - 128;
}

// Whole-texel reads in 8-bit levels: a filtered tap beside a hard edge picks
// up a sliver of the far side, lands within the threshold of the pixel and
// shifts it.
fn load_levels(p: vec2<i32>) -> vec4<i32> {
    let last = vec2<i32>(uniforms.frame_size) - vec2<i32>(1);
    let texel = textureLoad(source_texture, clamp(p, vec2<i32>(0), last), 0);
    return vec4<i32>(round(texel * 255.0));
}

// Replaces a pixel with the average of four random neighbours whenever every
// channel is within the threshold of that average: smooth gradients that the
// encoder quantised into steps blend back, while edges and text, which differ
// by far more than a couple of 8-bit levels, are left alone. Colours are kept
// in 1/256 of a level so four rounds of averaging stay exact.
@fragment
fn fs_deband(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {
    let pixel = vec2<u32>(frag_coord.xy);
    let p = vec2<i32>(pixel);
    let threshold = i32(round(uniforms.deband.x * 255.0 * 256.0));
    let iterations = i32(uniforms.deband.y);
    let radius = uniforms.deband.z;
    let seed = hash_u32(pixel.x * 0x9e3779b9u ^ hash_u32(pixel.y));

    var color = load_levels(p) * 256;
    for (var i = 1; i <= 4; i = i + 1) {
        if i <= iterations {
            let reach = i32(floor(radius * f32(i)));
            let span = u32(2 * reach + 1);
            let h = hash_u32(seed + u32(i) * 0x632be5abu);
            let offset = vec2<i32>(i32(h % span), i32((h >> 16u) % span)) - vec2<i32>(reach);
            let perpendicular = vec2<i32>(-offset.y, offset.x);
            let sum = load_levels(p + offset) + load_levels(p - offset)
                + load_levels(p + perpendicular) + load_levels(p - perpendicular);
            let average = sum * 64;
            let difference = abs(color - average);
            let largest = max(max(difference.x, difference.y), max(difference.z, difference.w));
            color = select(average, color, largest > threshold);
        }
    }

    let dither = bayer8(pixel) * color.w / (255 * 256);
    let rgb = clamp((color.xyz + vec3<i32>(dither) + vec3<i32>(128)) >> vec3<u32>(8u), vec3<i32>(0), vec3<i32>(255));
    let alpha = clamp((color.w + 128) >> 8u, 0, 255);
    return vec4<f32>(vec3<f32>(rgb), f32(alpha)) / 255.0;
}

fn lanczos3(x: f32) -> f32 {
    let t = abs(x);
    if t < 1e-5 {
        return 1.0;
    }
    if t >= 3.0 {
        return 0.0;
    }
    let pi_t = 3.141592653589793 * t;
    return 3.0 * sin(pi_t) * sin(pi_t / 3.0) / (pi_t * pi_t);
}

fn load_source(texel: vec2<i32>, lo: vec2<i32>, hi: vec2<i32>) -> vec4<f32> {
    return textureLoad(source_texture, clamp(texel, lo, hi), 0);
}

// Lanczos-3 resample of the source at the output pixel this texel covers,
// clamped to the range of the four nearest source texels so edges never ring.
// Region texel (0, 0) is output pixel `region_origin`, so the composite pass
// reads this texture one to one.
@fragment
fn fs_upscale(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {
    let output_px = uniforms.region_origin + frag_coord.xy;
    var target_uv = (output_px - uniforms.target_origin) / uniforms.target_size;
    if uniforms.params.y != 0.0 {
        target_uv.x = 1.0 - target_uv.x;
    }
    target_uv = clamp(target_uv, vec2<f32>(0.0), vec2<f32>(1.0));
    let source_px = uniforms.crop_min + target_uv * (uniforms.crop_max - uniforms.crop_min);
    let lo_px = floor(uniforms.crop_min);
    let hi_px = max(ceil(uniforms.crop_max) - vec2<f32>(1.0), lo_px);
    let texels_per_pixel = (uniforms.crop_max - uniforms.crop_min) / uniforms.target_size;
    if uniforms.deband.w != 0.0 && min(texels_per_pixel.x, texels_per_pixel.y) >= 1.0 {
        // Bilinear in the shader: filtering hardware rounds the weights to a
        // few bits on some GPUs, which moves high-contrast edges by a level.
        let p = clamp(source_px, lo_px + vec2<f32>(0.5), hi_px + vec2<f32>(0.5)) - vec2<f32>(0.5);
        let p0 = floor(p);
        let f = p - p0;
        let t0 = vec2<i32>(p0);
        let lo_i = vec2<i32>(lo_px);
        let hi_i = vec2<i32>(hi_px);
        let top = mix(load_source(t0, lo_i, hi_i), load_source(t0 + vec2<i32>(1, 0), lo_i, hi_i), f.x);
        let bottom = mix(
            load_source(t0 + vec2<i32>(0, 1), lo_i, hi_i),
            load_source(t0 + vec2<i32>(1, 1), lo_i, hi_i),
            f.x,
        );
        return mix(top, bottom, f.y);
    }
    let position = source_px - vec2<f32>(0.5);
    let base = floor(position);
    let fraction = position - base;
    let base_i = vec2<i32>(base);
    let lo = vec2<i32>(floor(uniforms.crop_min));
    let hi = max(vec2<i32>(ceil(uniforms.crop_max)) - vec2<i32>(1), lo);

    var weights_x: array<f32, 6>;
    var weights_y: array<f32, 6>;
    for (var i = 0; i < 6; i = i + 1) {
        weights_x[i] = lanczos3(fraction.x - f32(i - 2));
        weights_y[i] = lanczos3(fraction.y - f32(i - 2));
    }

    var accum = vec4<f32>(0.0);
    var weight_sum = 0.0;
    for (var j = 0; j < 6; j = j + 1) {
        for (var i = 0; i < 6; i = i + 1) {
            let weight = weights_x[i] * weights_y[j];
            accum += load_source(base_i + vec2<i32>(i - 2, j - 2), lo, hi) * weight;
            weight_sum += weight;
        }
    }
    let resampled = accum / weight_sum;

    let a = load_source(base_i, lo, hi);
    let b = load_source(base_i + vec2<i32>(1, 0), lo, hi);
    let c = load_source(base_i + vec2<i32>(0, 1), lo, hi);
    let d = load_source(base_i + vec2<i32>(1, 1), lo, hi);
    return clamp(resampled, min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));
}

// Robust contrast-adaptive sharpening (the RCAS formulation from AMD FSR 1,
// MIT licensed) over the upscaled region. The lobe is limited so the result
// never leaves the range of its four neighbours.
@fragment
fn fs_rcas(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {
    let p = vec2<i32>(frag_coord.xy);
    let hi = max(vec2<i32>(uniforms.params.zw) - vec2<i32>(1), vec2<i32>(0));
    let lo = vec2<i32>(0);
    let e = load_source(p, lo, hi);
    let b = load_source(p + vec2<i32>(0, -1), lo, hi).rgb;
    let d = load_source(p + vec2<i32>(-1, 0), lo, hi).rgb;
    let f = load_source(p + vec2<i32>(1, 0), lo, hi).rgb;
    let h = load_source(p + vec2<i32>(0, 1), lo, hi).rgb;

    let min4 = min(min(b, d), min(f, h));
    let max4 = max(max(b, d), max(f, h));
    let hit_min = min4 / max(4.0 * max4, vec3<f32>(1e-5));
    let hit_max = (vec3<f32>(1.0) - max4) / min(4.0 * min4 - vec3<f32>(4.0), vec3<f32>(-1e-5));
    let lobe_rgb = max(-hit_min, hit_max);
    let lobe = max(-0.1875, min(max(max(lobe_rgb.x, lobe_rgb.y), lobe_rgb.z), 0.0))
        * uniforms.params.x;
    let sharpened = (lobe * (b + d + f + h) + e.rgb) / (4.0 * lobe + 1.0);
    return vec4<f32>(clamp(sharpened, vec3<f32>(0.0), vec3<f32>(1.0)), e.a);
}
