struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct Uniforms {
    position_size: vec4<f32>,
    output_size: vec4<f32>,
    screen_bounds: vec4<f32>,
    motion_vector_strength: vec4<f32>,
    rotation_params: vec4<f32>,
    // Screen grade, identity when the cursor opts out.
    // (exposure stops, contrast, saturation, temperature).
    color_adjust_a: vec4<f32>,
    // (tint, fade, split_tone, vignette).
    color_adjust_b: vec4<f32>,
    // (grain amount, grain seed, grade-active flag, unused).
    grain_params: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

@group(0) @binding(1)
var t_cursor: texture_2d<f32>;

@group(0) @binding(2)
var s_cursor: sampler;

const MAX_ROTATION_RADIANS: f32 = 0.34906584;
// Smear length ceiling in sprite-UV (1.0 = one cursor-sprite width). A fast
// flick travels several sprite widths per frame, and the smear length must
// track it (Screen Studio semantics); this only bounds pathological
// teleports. The vertex quad expands by the same vector, so the geometry
// always contains the full streak.
const MAX_CURSOR_BLUR_UV: f32 = 4.0;

fn cursor_velocity_uv() -> vec2<f32> {
    let motion_vec = uniforms.motion_vector_strength.xy;
    let blur_strength = uniforms.motion_vector_strength.z;
    let cursor_size = uniforms.position_size.zw;
    let motion_len = length(motion_vec);

    if (motion_len < 0.5 || blur_strength < 0.001 || cursor_size.x <= 0.0 || cursor_size.y <= 0.0) {
        return vec2<f32>(0.0, 0.0);
    }

    let raw_velocity_uv = motion_vec / cursor_size;
    let raw_vel_len = length(raw_velocity_uv);

    if (raw_vel_len < 0.005) {
        return vec2<f32>(0.0, 0.0);
    }

    return raw_velocity_uv * min(1.0, MAX_CURSOR_BLUR_UV / raw_vel_len);
}

fn rotate_point(p: vec2<f32>, center: vec2<f32>, angle: f32) -> vec2<f32> {
    let cos_a = cos(angle);
    let sin_a = sin(angle);
    let translated = p - center;
    return vec2<f32>(
        translated.x * cos_a - translated.y * sin_a,
        translated.x * sin_a + translated.y * cos_a
    ) + center;
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var corners = array<vec2<f32>, 4>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0)
    );

    let blur_uv = cursor_velocity_uv();
    let uv_min = min(vec2<f32>(0.0, 0.0), -blur_uv);
    let uv_max = max(vec2<f32>(1.0, 1.0), vec2<f32>(1.0, 1.0) - blur_uv);
    let local_uv = uv_min + (uv_max - uv_min) * corners[vertex_index];
    let pos = vec2<f32>(local_uv.x, -local_uv.y);
    let screen_pos = uniforms.position_size.xy;
    let cursor_size = uniforms.position_size.zw;

    let base_rotation = uniforms.rotation_params.y;
    let x_movement_tilt = uniforms.rotation_params.z;

    let clamped_tilt = clamp(x_movement_tilt, -MAX_ROTATION_RADIANS, MAX_ROTATION_RADIANS);
    let rotation_angle = clamped_tilt + base_rotation;

    let pivot = vec2<f32>(0.0, 0.0);
    let rotated_pos = rotate_point(pos, pivot, rotation_angle);

    var adjusted_pos = screen_pos;
    adjusted_pos.y = uniforms.output_size.y - adjusted_pos.y;

    let final_pos = ((rotated_pos * cursor_size) + adjusted_pos) / uniforms.output_size.xy * 2.0 - 1.0;

    var output: VertexOutput;
    output.position = vec4<f32>(final_pos, 0.0, 1.0);
    output.uv = local_uv;
    return output;
}

fn sample_cursor(uv: vec2<f32>) -> vec4<f32> {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    return textureSample(t_cursor, s_cursor, uv);
}

// Confine the sprite to the display card (screen_bounds is the card's
// content rect in output px): a cursor whose source position is outside the
// visible crop slides off the card edge instead of floating over the
// background. Feathered ~1px to match the card's antialiased edge.
fn screen_bounds_mask(frag_pos: vec2<f32>) -> f32 {
    let b = uniforms.screen_bounds;
    let inside = min(
        min(frag_pos.x - b.x, b.z - frag_pos.x),
        min(frag_pos.y - b.y, b.w - frag_pos.y),
    );
    return clamp(inside + 0.5, 0.0, 1.0);
}

fn grain_hash(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Must stay in sync with composite-video-frame.wgsl and color-grade.wgsl.
// This pipeline blends premultiplied (One, OneMinusSrcAlpha), so the color
// is lifted to straight alpha before grading and re-premultiplied after —
// otherwise the grade's additive terms (fade, split tone, grain) bleed into
// the transparent parts of the motion smear.
fn apply_color_grade(color: vec4<f32>, frag_pos: vec2<f32>) -> vec4<f32> {
    if uniforms.grain_params.z < 0.5 || color.a < 0.001 {
        return color;
    }

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
    var rgb = (color.rgb / color.a) * exp2(exposure);

    // White balance, multiplicative so black stays black.
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

    // Split tone: teal shadows / orange highlights, luma-banded.
    let shadow_w = 1.0 - smoothstep(0.2, 0.65, luma);
    let highlight_w = smoothstep(0.35, 0.8, luma);
    rgb += split_tone * (
        shadow_w * vec3<f32>(-0.06, 0.02, 0.08) +
        highlight_w * vec3<f32>(0.08, 0.02, -0.06)
    );

    // Film fade: raised blacks, gently dulled highlights.
    rgb = rgb * (1.0 - 0.18 * fade) + vec3<f32>(0.09 * fade);

    // Always the frame-wide vignette field, matching the layers underneath.
    if vignette > 0.0 {
        let r = length((frag_pos / uniforms.output_size.xy - vec2<f32>(0.5)) * 2.0);
        rgb = rgb * (1.0 - vignette * 0.65 * smoothstep(0.5, 1.5, r));
    }

    // Midtone-peaked monochrome grain.
    if grain > 0.0 {
        let seed = uniforms.grain_params.y;
        let noise = grain_hash(frag_pos + vec2<f32>(seed * 17.0, seed * 29.0));
        let graded_luma = dot(
            clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)),
            vec3<f32>(0.2126, 0.7152, 0.0722)
        );
        let response = 0.25 + 0.75 * (1.0 - abs(2.0 * graded_luma - 1.0));
        rgb += (noise - 0.5) * grain * 0.35 * response;
    }

    return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * color.a, color.a);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let velocity_uv = cursor_velocity_uv();
    let blur_strength = uniforms.motion_vector_strength.z;
    let opacity = uniforms.motion_vector_strength.w * screen_bounds_mask(input.position.xy);
    let base_color = sample_cursor(input.uv);

    if (length(velocity_uv) < 0.005 || blur_strength < 0.001) {
        return apply_color_grade(base_color * opacity, input.position.xy);
    }

    // 21-tap box along the motion vector, output fully blurred: the amount
    // scales the smear LENGTH (baked into velocity_uv on the CPU side), never
    // a crossfade with the sharp sprite — a sharp copy over a smear reads as
    // ghosting. Transparent taps shorten the effective alpha, which is what
    // stretches and fades the sprite along fast motion.
    let kernel_size = 21.0;
    let k = kernel_size - 1.0;
    var color = base_color;

    for (var i = 1; i <= 20; i = i + 1) {
        let bias = velocity_uv * (f32(i) / k);
        let sample_uv = input.uv + bias;
        color += sample_cursor(sample_uv);
    }

    color /= kernel_size;
    return apply_color_grade(color * opacity, input.position.xy);
}
