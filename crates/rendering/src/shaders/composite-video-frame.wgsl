struct Uniforms {
    crop_bounds: vec4<f32>,
    target_bounds: vec4<f32>,
    output_size: vec2<f32>,
    frame_size: vec2<f32>,
    motion_blur_vector: vec2<f32>,
    motion_blur_zoom_center: vec2<f32>,
    motion_blur_params: vec4<f32>,
    target_size: vec2<f32>,
    rounding_px: f32,
    rounding_type: f32,
    mirror_x: f32,
    shadow: f32,
    shadow_size: f32,
    shadow_opacity: f32,
    shadow_blur: f32,
    opacity: f32,
    border_enabled: f32,
    border_width: f32,
    preserve_source_alpha: f32,
    _padding1a: f32,
    _padding1b: f32,
    _padding1c: f32,
    border_color: vec4<f32>,
    // Per-corner multipliers on rounding_px: (tl, tr, bl, br). All 1s keeps
    // the uniform rounding; the display squares its top corners against
    // decorative frame chrome with (0, 0, 1, 1).
    corner_radii: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var frame_texture: texture_2d<f32>;
@group(0) @binding(2) var frame_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );

    var out: VertexOutput;
    out.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
    out.uv = (positions[vertex_index] + 1.0) * 0.5;
    return out;
}

// Safety ceiling on the radial zoom-blur ray length in card-UV. Real zoom
// springs produce rays around 0.03-0.05 at the far corners; this only guards
// synthetic or pathological amounts.
const MAX_ZOOM_RAY_UV: f32 = 0.10;

// Per-pixel random phase used to dither the fixed 13-tap zoom kernel
// (deterministic in the fragment position, so renders stay reproducible).
fn interleaved_noise(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

fn superellipse_norm(p: vec2<f32>, power: f32) -> f32 {
    let x = pow(abs(p.x), power);
    let y = pow(abs(p.y), power);
    return pow(x + y, 1.0 / power);
}

fn rounded_corner_norm(p: vec2<f32>, rounding_type: f32) -> f32 {
    if rounding_type < 0.5 {
        return length(p);
    }

    let power = 4.0;
    return superellipse_norm(p, power);
}

// Radius for the corner of the quadrant `p` (center-relative) falls in.
fn corner_radius_for(p: vec2<f32>) -> f32 {
    let multiplier = select(
        select(uniforms.corner_radii.w, uniforms.corner_radii.z, p.x < 0.0),
        select(uniforms.corner_radii.y, uniforms.corner_radii.x, p.x < 0.0),
        p.y < 0.0
    );
    return uniforms.rounding_px * multiplier;
}

fn sdf_rounded_rect(p: vec2<f32>, b: vec2<f32>, r: f32, rounding_type: f32) -> f32 {
    let q = abs(p) - b + vec2<f32>(r);
    let outside = max(q, vec2<f32>(0.0));
    let outside_norm = rounded_corner_norm(outside, rounding_type);
    return outside_norm + min(max(q.x, q.y), 0.0) - r;
}

fn coverage_from_distance(distance: f32, anti_alias_width: f32) -> f32 {
    return clamp(1.0 - smoothstep(-anti_alias_width, anti_alias_width, distance), 0.0, 1.0);
}

fn rounded_rect_coverage(p: vec2<f32>, b: vec2<f32>, r: f32, rounding_type: f32) -> f32 {
    let distance = sdf_rounded_rect(p, b, r, rounding_type);
    let anti_alias_width = max(fwidth(distance), 1.0);

    if distance <= -anti_alias_width {
        return 1.0;
    }

    if distance >= anti_alias_width {
        return 0.0;
    }

    let subpixel_offset = 0.25;
    var coverage = 0.0;
    coverage += coverage_from_distance(
        sdf_rounded_rect(p + vec2<f32>(-subpixel_offset, -subpixel_offset), b, r, rounding_type),
        anti_alias_width
    );
    coverage += coverage_from_distance(
        sdf_rounded_rect(p + vec2<f32>(subpixel_offset, -subpixel_offset), b, r, rounding_type),
        anti_alias_width
    );
    coverage += coverage_from_distance(
        sdf_rounded_rect(p + vec2<f32>(-subpixel_offset, subpixel_offset), b, r, rounding_type),
        anti_alias_width
    );
    coverage += coverage_from_distance(
        sdf_rounded_rect(p + vec2<f32>(subpixel_offset, subpixel_offset), b, r, rounding_type),
        anti_alias_width
    );
    return coverage * 0.25;
}

fn composite_source_over(foreground: vec4<f32>, background: vec4<f32>) -> vec4<f32> {
    let alpha = foreground.a + background.a * (1.0 - foreground.a);

    if alpha <= 0.0001 {
        return vec4<f32>(0.0);
    }

    let color = (
        foreground.rgb * foreground.a +
        background.rgb * background.a * (1.0 - foreground.a)
    ) / alpha;

    return vec4<f32>(color, alpha);
}

@fragment
fn fs_main(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {
    let p = frag_coord.xy;
    let center = (uniforms.target_bounds.xy + uniforms.target_bounds.zw) * 0.5;
    let size = (uniforms.target_bounds.zw - uniforms.target_bounds.xy) * 0.5;
    
    let dist = sdf_rounded_rect(p - center, size, corner_radius_for(p - center), uniforms.rounding_type);

    let min_frame_size = min(size.x, size.y);
    let shadow_enabled = uniforms.shadow > 0.0;

    // Get shadow parameters, either from advanced settings or fallback to basic shadow
    let shadow_strength = uniforms.shadow / 100.0;

    // Use shadow_strength as a multiplier for all advanced settings
    let shadow_size = select(
        shadow_strength * min_frame_size,
        shadow_strength * (uniforms.shadow_size / 100.0) * min_frame_size,
        shadow_enabled
    );

    let shadow_opacity = select(
        shadow_strength * 0.18,
        shadow_strength * (uniforms.shadow_opacity / 100.0),
        shadow_enabled
    );

    let shadow_blur = select(
        shadow_strength * min_frame_size * 0.5,
        shadow_strength * (uniforms.shadow_blur / 100.0) * min_frame_size,
        shadow_enabled
    );

    let shadow_dist = dist;

    // Apply blur and size to shadow
    let shadow_strength_final = smoothstep(shadow_size + shadow_blur, -shadow_blur, abs(shadow_dist));
    let shadow_color = vec4<f32>(0.0, 0.0, 0.0, shadow_strength_final * shadow_opacity);

    let target_uv = (p - uniforms.target_bounds.xy) / uniforms.target_size;
    let crop_bounds_uv = vec4<f32>(uniforms.crop_bounds.xy / uniforms.frame_size, uniforms.crop_bounds.zw / uniforms.frame_size);
    let edge_padding = max(2.0, uniforms.border_width + 2.0);
    let edge_padding_uv = edge_padding / uniforms.target_size;

    // How far outside the card the motion smear can land (card-UV). Zero when
    // blur is inactive so the early-outs below stay as tight as before.
    let blur_mode = uniforms.motion_blur_params.x;
    let blur_strength = uniforms.motion_blur_params.y;
    let blur_active = blur_mode >= 0.5 && blur_strength >= 0.001;
    var blur_reach_uv = vec2<f32>(0.0);
    if blur_active {
        if blur_mode < 1.5 {
            blur_reach_uv = abs(uniforms.motion_blur_vector);
        } else {
            blur_reach_uv = vec2<f32>(MAX_ZOOM_RAY_UV);
        }
    }

    if target_uv.x < -edge_padding_uv.x - blur_reach_uv.x ||
        target_uv.x > 1.0 + edge_padding_uv.x + blur_reach_uv.x ||
        target_uv.y < -edge_padding_uv.y - blur_reach_uv.y ||
        target_uv.y > 1.0 + edge_padding_uv.y + blur_reach_uv.y
    {
        return shadow_color;
    }

    if (uniforms.border_enabled > 0.0) {
        let border_outer_coverage = rounded_rect_coverage(
            p - center,
            size + vec2<f32>(uniforms.border_width),
            corner_radius_for(p - center) + uniforms.border_width,
            uniforms.rounding_type
        );
        let border_inner_coverage = rounded_rect_coverage(
            p - center,
            size,
            corner_radius_for(p - center),
            uniforms.rounding_type
        );
        let border_coverage = clamp(border_outer_coverage - border_inner_coverage, 0.0, 1.0);

        if (border_coverage > 0.001) {
            let border_color = vec4<f32>(
                uniforms.border_color.xyz,
                border_coverage * uniforms.border_color.w
            );
            return composite_source_over(border_color, shadow_color);
        }
    }

    let shape_coverage = rounded_rect_coverage(
        p - center,
        size,
        corner_radius_for(p - center),
        uniforms.rounding_type
    );

    // Outside the card the blur can still land content (the smear escapes the
    // card edge along the motion), so only take the fast exit when inactive.
    if shape_coverage <= 0.001 && !blur_active {
        return shadow_color;
    }

    let sample_target_uv = clamp(target_uv, vec2<f32>(0.0), vec2<f32>(1.0));
    var base_color = sample_texture(sample_target_uv, crop_bounds_uv);
    base_color.a = base_color.a * shape_coverage * uniforms.opacity;

    let zoom_amount = uniforms.motion_blur_params.z;

    if !blur_active {
        return composite_source_over(base_color, shadow_color);
    }

    // Screen Studio semantics: the user amount is baked into the LENGTH of
    // the kernel (velocity vector / zoom ray) on the CPU side, and the output
    // is the fully blurred result — never a crossfade with the sharp frame
    // (a sharp copy mixed over a smear reads as ghosting, not motion). Alpha
    // is accumulated with the same kernel so the card edge smears along the
    // motion instead of staying crisp around streaked content. A zero-length
    // kernel is the identity, so blur fades in and out with velocity
    // continuously and needs no strength ramp.
    if blur_mode < 1.5 {
        let velocity_uv = uniforms.motion_blur_vector;
        if length(velocity_uv) < 1e-5 {
            return composite_source_over(base_color, shadow_color);
        }

        // 21-tap box along [0, +v]: matches the reference directional filter
        // (kernel 21 with offset -|v|/2, which anchors the span at the pixel).
        var accum = vec3<f32>(0.0);
        var alpha_sum = 0.0;
        let k = 20.0;

        for (var i = 0; i <= 20; i = i + 1) {
            let sample_uv = target_uv + velocity_uv * (f32(i) / k);
            var tap = sample_texture(sample_uv, crop_bounds_uv);
            tap = apply_rounded_corners(tap, sample_uv);
            accum += tap.rgb * tap.a;
            alpha_sum += tap.a;
        }

        let out_alpha = (alpha_sum / 21.0) * uniforms.opacity;
        if out_alpha <= 0.0001 || alpha_sum <= 0.0001 {
            return shadow_color;
        }
        return composite_source_over(vec4(accum / alpha_sum, out_alpha), shadow_color);
    }

    let zoom_center = uniforms.motion_blur_zoom_center;
    let dir = zoom_center - target_uv;
    let center_dist = length(dir);
    if center_dist < 1e-4 || zoom_amount < 1e-4 {
        return composite_source_over(base_color, shadow_color);
    }

    // Radial blur toward the scale origin: ray length grows with distance
    // from the center (ray = center_dist * amount), parabolic weights peaked
    // mid-ray, and a per-pixel random phase to dither the 13-tap banding —
    // all matching the reference zoom filter.
    let scaled_dir = dir / center_dist * min(center_dist * min(zoom_amount, 1.0), MAX_ZOOM_RAY_UV);
    let max_kernel = 13.0;
    let dither = interleaved_noise(p);

    var accum = vec3<f32>(0.0);
    var alpha_sum = 0.0;
    var weight_sum = 0.0;

    for (var i = 0; i < 13; i = i + 1) {
        let percent = (f32(i) + dither) / max_kernel;
        let weight = 4.0 * (percent - percent * percent);
        let sample_uv = target_uv + scaled_dir * percent;

        var tap = sample_texture(sample_uv, crop_bounds_uv);
        tap = apply_rounded_corners(tap, sample_uv);
        accum += tap.rgb * tap.a * weight;
        alpha_sum += tap.a * weight;
        weight_sum += weight;
    }

    if weight_sum <= 0.0001 || alpha_sum <= 0.0001 {
        return shadow_color;
    }
    let out_alpha = (alpha_sum / weight_sum) * uniforms.opacity;
    if out_alpha <= 0.0001 {
        return shadow_color;
    }
    return composite_source_over(vec4(accum / alpha_sum, out_alpha), shadow_color);
}

fn sample_texture(uv: vec2<f32>, crop_bounds_uv: vec4<f32>) -> vec4<f32> {
    if uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0 {
        var sample_uv = uv;
        if uniforms.mirror_x != 0.0 {
            sample_uv.x = 1.0 - sample_uv.x;
        }

        let crop_size = crop_bounds_uv.zw - crop_bounds_uv.xy;
        var cropped_uv = sample_uv * crop_size + crop_bounds_uv.xy;

        let texel_offset = 1.0 / uniforms.frame_size;
        let safe_min = crop_bounds_uv.xy + texel_offset;
        let safe_max = crop_bounds_uv.zw - texel_offset;
        cropped_uv = clamp(cropped_uv, safe_min, safe_max);

        let source_size = uniforms.frame_size * crop_size;
        let target_size = uniforms.target_size;
        let scale_ratio = source_size / target_size;
        let is_downscaling = max(scale_ratio.x, scale_ratio.y) > 1.1;
        let upscale_ratio = max(target_size.x / source_size.x, target_size.y / source_size.y);
        let is_upscaling = upscale_ratio > 1.05;

        let center_sample = textureSample(frame_texture, frame_sampler, cropped_uv);
        let center_color = center_sample.rgb;
        let out_alpha = select(1.0, center_sample.a, uniforms.preserve_source_alpha > 0.5);

        if is_downscaling {
            let texel_size = 1.0 / uniforms.frame_size;

            let offset_x = vec2<f32>(texel_size.x, 0.0);
            let offset_y = vec2<f32>(0.0, texel_size.y);

            let left = textureSample(
                frame_texture,
                frame_sampler,
                clamp(cropped_uv - offset_x, safe_min, safe_max)
            ).rgb;
            let right = textureSample(
                frame_texture,
                frame_sampler,
                clamp(cropped_uv + offset_x, safe_min, safe_max)
            ).rgb;
            let top = textureSample(
                frame_texture,
                frame_sampler,
                clamp(cropped_uv - offset_y, safe_min, safe_max)
            ).rgb;
            let bottom = textureSample(
                frame_texture,
                frame_sampler,
                clamp(cropped_uv + offset_y, safe_min, safe_max)
            ).rgb;

            let blurred = (left + right + top + bottom) * 0.25;

            let sharpness = min(scale_ratio.x * 0.3, 0.7);
            let sharpened = center_color + (center_color - blurred) * sharpness;

            return vec4(clamp(sharpened, vec3<f32>(0.0), vec3<f32>(1.0)), out_alpha);
        }

        if is_upscaling {
            let texel_size = 1.0 / uniforms.frame_size;

            let offset_x = vec2<f32>(texel_size.x, 0.0);
            let offset_y = vec2<f32>(0.0, texel_size.y);

            let left = textureSample(
                frame_texture,
                frame_sampler,
                clamp(cropped_uv - offset_x, safe_min, safe_max)
            ).rgb;
            let right = textureSample(
                frame_texture,
                frame_sampler,
                clamp(cropped_uv + offset_x, safe_min, safe_max)
            ).rgb;
            let top = textureSample(
                frame_texture,
                frame_sampler,
                clamp(cropped_uv - offset_y, safe_min, safe_max)
            ).rgb;
            let bottom = textureSample(
                frame_texture,
                frame_sampler,
                clamp(cropped_uv + offset_y, safe_min, safe_max)
            ).rgb;

            let blurred = (left + right + top + bottom) * 0.25;
            let sharpness = min((upscale_ratio - 1.0) * 0.25, 0.45);
            let sharpened = center_color + (center_color - blurred) * sharpness;

            return vec4(clamp(sharpened, vec3<f32>(0.0), vec3<f32>(1.0)), out_alpha);
        }

        return vec4(center_color, out_alpha);
    }

    return vec4(0.0);
}

fn apply_rounded_corners(current_color: vec4<f32>, target_uv: vec2<f32>) -> vec4<f32> {
    let centered_uv = (target_uv - vec2<f32>(0.5)) * uniforms.target_size;
    let half_size = uniforms.target_size * 0.5;
    let coverage = rounded_rect_coverage(
        centered_uv,
        half_size,
        corner_radius_for(centered_uv),
        uniforms.rounding_type
    );

    return vec4(current_color.rgb, current_color.a * coverage);
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}
