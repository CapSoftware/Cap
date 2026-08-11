// Screen-space focus blur system.
//
// The "depth of field" is a UV-mask variable-radius blur: a per-pixel CoC
// (blur radius in output pixels) computed from the focus configuration, fed to
// either a separable gaussian (two passes, pass 0 = horizontal, pass 1 =
// vertical) or a single-pass ring-disc bokeh kernel with highlight gain
// (pass 2). Runs on the fully composed frame; the sharp region is wherever
// the focus mask says it is, exactly like the original.
//
// params0: (pass, mode, strength_px, falloff)
//   pass: 0 = gaussian H, 1 = gaussian V, 2 = bokeh
//   mode: 1 = radial, 2 = directional, 3 = tilt-shift
//   strength_px: blur radius, already scaled to this render resolution
// params1: (focus_x, focus_y, focus_size, angle_rad)
// params2: (dir_position, resolution_x, resolution_y, unused)
//
// Focus coordinates and angles work in GL-style UV space (origin bottom-left,
// y up), matching the original shaders; screen_uv is converted on entry.

struct Camera3DBlurUniforms {
    params0: vec4<f32>,
    params1: vec4<f32>,
    params2: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Camera3DBlurUniforms;
@group(0) @binding(1) var t_source: texture_2d<f32>;
@group(0) @binding(2) var s_source: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) screen_uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    let uv = vec2<f32>(
        f32((vertex_index << 1u) & 2u),
        f32(vertex_index & 2u),
    );
    var out: VertexOutput;
    out.position = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
    out.screen_uv = vec2<f32>(uv.x, 1.0 - uv.y);
    return out;
}

// CoC (circle of confusion) function.
fn blur_amount(gl_uv: vec2<f32>) -> f32 {
    let mode = u.params0.y;
    let strength = u.params0.z;
    let falloff = u.params0.w;
    let resolution = u.params2.yz;
    let aspect = resolution.x / max(resolution.y, 1.0);

    let widen = 1.0 + falloff * 3.0;
    let curve = mix(2.0, 0.7, falloff);

    if (mode == 2.0) {
        // Directional: one-sided blur past a line through frame center.
        let angle = u.params1.w;
        let dir = vec2<f32>(cos(angle), sin(angle));
        var diff = gl_uv - vec2<f32>(0.5);
        diff.x = diff.x * aspect;
        let projected = dot(diff, dir);
        let reach = aspect * 0.5 + 0.5;
        let threshold = mix(-reach, reach, u.params2.x);
        let d = max(projected - threshold, 0.0);
        let t = smoothstep(0.0, 0.7 * widen, d);
        return pow(t, curve) * strength;
    }

    var diff = gl_uv - u.params1.xy;
    diff.x = diff.x * aspect;

    var dist = 0.0;
    if (mode == 3.0) {
        // Tilt-shift: sharp band around the focus line.
        let angle = u.params1.w;
        let perp = vec2<f32>(sin(angle), cos(angle));
        let d = abs(dot(diff, perp));
        let band = u.params1.z * 0.5;
        dist = max(d - band, 0.0);
    } else {
        // Radial: sharp circle around the focus point.
        dist = length(diff);
    }

    let edge = u.params1.z * 0.5;
    let t = smoothstep(0.0, (edge + 0.35) * widen, dist - edge);
    return pow(t, curve) * strength;
}

fn gaussian(gl_uv: vec2<f32>, screen_uv: vec2<f32>, horizontal: bool) -> vec4<f32> {
    let coc = blur_amount(gl_uv);
    let center = textureSampleLevel(t_source, s_source, screen_uv, 0.0);
    if (coc < 0.5) {
        return center;
    }

    let resolution = u.params2.yz;
    let texel = 1.0 / max(resolution, vec2<f32>(1.0));
    // The radius cap scales with output height, exactly like strength_px does
    // on the CPU side (camera3d.rs), so the kernel covers the same fraction of
    // the gaussian curve at every resolution and preview matches export. The
    // flat ceiling (the scaled cap at 8K) bounds per-fragment cost.
    let radius_cap = min(resolution.y * (40.0 / 1080.0), 160.0);
    let radius = i32(min(coc, radius_cap));
    let sigma = coc * 0.5;
    let inv_sigma2 = 1.0 / (2.0 * sigma * sigma);

    var color = vec4<f32>(0.0);
    var total = 0.0;
    for (var i = -radius; i <= radius; i++) {
        let fi = f32(i);
        let weight = exp(-fi * fi * inv_sigma2);
        var offset: vec2<f32>;
        if (horizontal) {
            offset = vec2<f32>(texel.x * fi, 0.0);
        } else {
            offset = vec2<f32>(0.0, texel.y * fi);
        }
        color += textureSampleLevel(t_source, s_source, screen_uv + offset, 0.0) * weight;
        total += weight;
    }
    return color / max(total, 1e-6);
}

// Ring-disc bokeh: 3 rings × (5·ring) samples with highlight gain, so bright
// spots read as discs. Offsets are aspect-corrected to circles (fixing the
// original's inverted correction).
fn bokeh(gl_uv: vec2<f32>, screen_uv: vec2<f32>) -> vec4<f32> {
    let coc = blur_amount(gl_uv);
    let center = textureSampleLevel(t_source, s_source, screen_uv, 0.0);
    if (coc < 0.5) {
        return center;
    }

    let resolution = u.params2.yz;
    let texel = 1.0 / max(resolution, vec2<f32>(1.0));
    let aspect = resolution.x / max(resolution.y, 1.0);
    let ring_step = coc / 3.0;

    var acc = center;
    var wsum = 1.0;
    for (var ring = 1; ring <= 3; ring++) {
        let ring_samples = ring * 5;
        let r = f32(ring) * ring_step;
        let ring_weight = mix(1.0, f32(ring) / 3.0, 0.3);
        for (var j = 0; j < 15; j++) {
            if (j >= ring_samples) {
                break;
            }
            let a = 6.28318530718 * f32(j) / f32(ring_samples);
            let offset = vec2<f32>(cos(a) / aspect, sin(a)) * r * texel.y;
            // texel.y scale + /aspect on x keeps the disc circular on screen.
            let s = textureSampleLevel(t_source, s_source, screen_uv + vec2<f32>(offset.x, -offset.y), 0.0);
            let luma = dot(s.rgb, vec3<f32>(0.299, 0.587, 0.114));
            let gain = 1.0 + smoothstep(0.7, 1.0, luma) * 1.5;
            acc += s * ring_weight * gain;
            wsum += ring_weight * gain;
        }
    }
    return acc / wsum;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let gl_uv = vec2<f32>(in.screen_uv.x, 1.0 - in.screen_uv.y);
    let pass_kind = u.params0.x;
    if (pass_kind == 2.0) {
        return bokeh(gl_uv, in.screen_uv);
    }
    return gaussian(gl_uv, in.screen_uv, pass_kind == 0.0);
}
