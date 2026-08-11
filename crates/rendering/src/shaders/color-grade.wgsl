// Full-frame color grade for the background canvas. Runs between the
// background (+ its blur) and the display layer so the backdrop wears the
// same grade as the screen and the padded scene reads as one frame.
//
// The grade math MUST stay in sync with apply_color_grade in
// composite-video-frame.wgsl: the display card applies the same grade in its
// own shader, and grain + vignette are computed in the same output-pixel
// space so the two layers meet seamlessly at the card edge.

struct Uniforms {
    // (exposure stops, contrast, saturation, temperature).
    color_adjust_a: vec4<f32>,
    // (tint, fade, split_tone, vignette).
    color_adjust_b: vec4<f32>,
    // (grain amount, per-frame grain seed, grade-active flag, unused).
    grain_params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var frame_texture: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    return vec4<f32>(positions[vertex_index], 0.0, 1.0);
}

fn grain_hash(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

@fragment
fn fs_main(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {
    let color = textureLoad(frame_texture, vec2<i32>(frag_coord.xy), 0);

    let exposure = uniforms.color_adjust_a.x;
    let contrast = uniforms.color_adjust_a.y;
    let saturation = uniforms.color_adjust_a.z;
    let temperature = uniforms.color_adjust_a.w;
    let tint = uniforms.color_adjust_b.x;
    let fade = uniforms.color_adjust_b.y;
    let split_tone = uniforms.color_adjust_b.z;
    let vignette = uniforms.color_adjust_b.w;
    let grain = uniforms.grain_params.x;

    // Exposure in stops.
    var rgb = color.rgb * exp2(exposure);

    // White balance: temperature trades red against blue, tint trades green
    // against magenta. Multiplicative so black stays black.
    rgb = rgb * vec3<f32>(
        1.0 + 0.10 * temperature + 0.04 * tint,
        1.0 - 0.07 * tint,
        1.0 - 0.10 * temperature + 0.04 * tint,
    );

    // Contrast around mid gray.
    rgb = (rgb - vec3<f32>(0.5)) * (1.0 + contrast) + vec3<f32>(0.5);

    // Saturation via luma mix (-1 = grayscale).
    let luma = dot(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(0.2126, 0.7152, 0.0722));
    rgb = mix(vec3<f32>(luma), rgb, 1.0 + saturation);

    // Split toning: teal into shadows, orange into highlights (reversed when
    // the amount is negative), weighted by luma bands.
    let shadow_w = 1.0 - smoothstep(0.2, 0.65, luma);
    let highlight_w = smoothstep(0.35, 0.8, luma);
    rgb += split_tone * (
        shadow_w * vec3<f32>(-0.06, 0.02, 0.08) +
        highlight_w * vec3<f32>(0.08, 0.02, -0.06)
    );

    // Film fade: raised blacks, gently dulled highlights.
    rgb = rgb * (1.0 - 0.18 * fade) + vec3<f32>(0.09 * fade);

    // Full-frame vignette (the display card computes its vignette in the
    // same output space, so the field is continuous across the card edge).
    if vignette > 0.0 {
        let dims = vec2<f32>(textureDimensions(frame_texture));
        let r = length((frag_coord.xy / dims - vec2<f32>(0.5)) * 2.0);
        rgb = rgb * (1.0 - vignette * 0.65 * smoothstep(0.5, 1.5, r));
    }

    // Animated monochrome grain, peaked in the midtones like scanned film.
    // Same hash, coordinates, and seed as the display layer so the noise
    // field is continuous across the card boundary.
    if grain > 0.0 {
        let seed = uniforms.grain_params.y;
        let noise = grain_hash(frag_coord.xy + vec2<f32>(seed * 17.0, seed * 29.0));
        let graded_luma = dot(
            clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)),
            vec3<f32>(0.2126, 0.7152, 0.0722)
        );
        let response = 0.25 + 0.75 * (1.0 - abs(2.0 * graded_luma - 1.0));
        rgb += (noise - 0.5) * grain * 0.35 * response;
    }

    return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)), color.a);
}
