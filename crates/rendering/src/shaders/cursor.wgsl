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
    // The screen's motion blur this frame, which the cursor rides inside:
    // (mode 0 none / 1 move / 2 zoom, then for move the smear in output px,
    // for zoom the centre in card UV and the zoom amount).
    screen_blur: vec4<f32>,
    // The display card in output px (x, y, width, height).
    screen_card: vec4<f32>,
    // (how far the screen's zoom blur can carry the sprite, in output px,
    // unused x3).
    screen_reach: vec4<f32>,
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
// track it (length-based semantics); this only bounds pathological
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

// An offset on the frame (output px, y down) in the sprite's own UV, through
// the inverse of the vertex transform, so the screen's blur keeps its
// direction however the cursor tilts.
fn px_to_sprite_uv(offset: vec2<f32>) -> vec2<f32> {
    let size = max(uniforms.position_size.zw, vec2<f32>(1.0));
    let angle = clamp(uniforms.rotation_params.z, -MAX_ROTATION_RADIANS, MAX_ROTATION_RADIANS)
        + uniforms.rotation_params.y;
    let s = sin(angle);
    let c = cos(angle);
    return vec2<f32>(
        c * offset.x / size.x - s * offset.y / size.y,
        s * offset.x / size.x + c * offset.y / size.y
    );
}

// The screen's directional smear in sprite UV; zero unless it is moving.
fn screen_move_uv() -> vec2<f32> {
    if (uniforms.screen_blur.x < 0.5 || uniforms.screen_blur.x >= 1.5) {
        return vec2<f32>(0.0, 0.0);
    }
    return px_to_sprite_uv(uniforms.screen_blur.yz);
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

    let screen_pos = uniforms.position_size.xy;
    let cursor_size = uniforms.position_size.zw;
    // The quad covers the sprite plus everywhere its own smear and the
    // screen's smear can carry it.
    let blur_uv = cursor_velocity_uv();
    let screen_uv = screen_move_uv();
    // Rotation mixes the axes, so a zoom's reach widens both by the larger.
    let reach_uv = vec2<f32>(uniforms.screen_reach.x / max(min(cursor_size.x, cursor_size.y), 1.0));
    let uv_min = min(vec2<f32>(0.0), -blur_uv) + min(vec2<f32>(0.0), -screen_uv) - reach_uv;
    let uv_max = vec2<f32>(1.0) + max(vec2<f32>(0.0), -blur_uv)
        + max(vec2<f32>(0.0), -screen_uv) + reach_uv;
    let local_uv = uv_min + (uv_max - uv_min) * corners[vertex_index];
    let pos = vec2<f32>(local_uv.x, -local_uv.y);

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
    // Keep implicit mip derivatives uniform across the sprite boundary.
    let color = textureSample(t_cursor, s_cursor, uv);
    let inside = all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0));
    return select(vec4<f32>(0.0), color, inside);
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
    let opacity = uniforms.motion_vector_strength.w;
    let p = input.position.xy;
    let mode = uniforms.screen_blur.x;

    // The cursor rides inside the screen, so the screen's blur lands on it
    // too, over the cursor's own: a pan smears it along the pan, a zoom
    // pulls it toward the zoom centre. Each of the screen's taps is clipped
    // to the card where that tap lands, as the screen's own content is.
    var color = vec4<f32>(0.0);
    if (mode < 0.5) {
        color = own_blurred(input.uv, velocity_uv) * screen_bounds_mask(p);
    } else if (mode < 1.5) {
        let smear_px = uniforms.screen_blur.yz;
        color = own_blurred(input.uv, velocity_uv) * screen_bounds_mask(p) * 2.0;
        for (var i = 1; i < 20; i = i + 1) {
            let offset_px = smear_px * (f32(i) / 20.0);
            color += own_blurred(input.uv + px_to_sprite_uv(offset_px), velocity_uv)
                * screen_bounds_mask(p + offset_px);
        }
        color /= 21.0;
    } else {
        let card = uniforms.screen_card;
        let card_size = max(card.zw, vec2<f32>(1.0));
        let dir = uniforms.screen_blur.yz - (p - card.xy) / card_size;
        let dist = length(dir);
        let amount = min(uniforms.screen_blur.w, 1.0);
        if (dist < 1e-4 || amount < 1e-4) {
            color = own_blurred(input.uv, velocity_uv) * screen_bounds_mask(p);
        } else {
            let ray_px = dir / dist * min(dist * amount, MAX_ZOOM_RAY_UV) * card_size;
            let dither = interleaved_noise(p);
            var weight_sum = 0.0;
            for (var i = 0; i < 13; i = i + 1) {
                let percent = (f32(i) + dither) / 13.0;
                let weight = 4.0 * (percent - percent * percent);
                let offset_px = ray_px * percent;
                color += own_blurred(input.uv + px_to_sprite_uv(offset_px), velocity_uv)
                    * screen_bounds_mask(p + offset_px) * weight;
                weight_sum += weight;
            }
            color /= max(weight_sum, 1e-4);
        }
    }

    return apply_color_grade(color * opacity, p);
}

// Same ceiling as the display's radial blur (composite-video-frame.wgsl).
const MAX_ZOOM_RAY_UV: f32 = 0.10;

// Same per-pixel phase as the display's radial blur, so the cursor's taps
// line up with the screen's around it.
fn interleaved_noise(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

// The cursor's own directional smear: 21 taps along [0, 0.95 v], the first
// counted twice, as the reference directional filter samples.
fn own_blurred(uv: vec2<f32>, velocity_uv: vec2<f32>) -> vec4<f32> {
    if (length(velocity_uv) < 0.005) {
        return sample_cursor(uv);
    }
    var color = sample_cursor(uv) * 2.0;
    for (var i = 1; i < 20; i = i + 1) {
        color += sample_cursor(uv + velocity_uv * (f32(i) / 20.0));
    }
    return color / 21.0;
}

