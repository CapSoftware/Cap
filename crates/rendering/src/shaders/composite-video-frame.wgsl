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
    // (exposure stops, contrast, saturation, temperature).
    color_adjust_a: vec4<f32>,
    // (tint, fade, split_tone, vignette).
    color_adjust_b: vec4<f32>,
    // (grain amount, grain seed, grade-active flag, full-frame vignette flag).
    grain_params: vec4<f32>,
    // Output-pixel rect (x, y, width, height) that `enhanced_texture` covers
    // one to one.
    enhance_region: vec4<f32>,
    // (upscale mix, detail downscale flag, unused, unused). Zero leaves the
    // plain sample.
    enhance_params: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var frame_texture: texture_2d<f32>;
@group(0) @binding(2) var frame_sampler: sampler;
@group(0) @binding(3) var enhanced_texture: texture_2d<f32>;

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

// Sin-free hash so grain stays stable across GPU drivers.
fn grain_hash(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Must stay in sync with color-grade.wgsl and cursor.wgsl. Runs once per
// output pixel after motion-blur resolve; ungraded layers skip everything in
// a single coherent uniform branch.
fn apply_color_grade(color: vec4<f32>, target_uv: vec2<f32>, frag_pos: vec2<f32>) -> vec4<f32> {
    if uniforms.grain_params.z < 0.5 {
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
    var rgb = color.rgb * exp2(exposure);

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

    if vignette > 0.0 {
        var vig_uv = target_uv;
        if uniforms.grain_params.w > 0.5 {
            vig_uv = frag_pos / uniforms.output_size;
        }
        let r = length((vig_uv - vec2<f32>(0.5)) * 2.0);
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

    return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)), color.a);
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

    // Evaluate coverage before the apron return so fwidth retains every helper lane.
    let shape_coverage = rounded_rect_coverage(
        p - center,
        size,
        corner_radius_for(p - center),
        uniforms.rounding_type
    );
    var border_coverage = 0.0;
    if (uniforms.border_enabled > 0.0) {
        let border_outer_coverage = rounded_rect_coverage(
            p - center,
            size + vec2<f32>(uniforms.border_width),
            corner_radius_for(p - center) + uniforms.border_width,
            uniforms.rounding_type
        );
        border_coverage = clamp(border_outer_coverage - shape_coverage, 0.0, 1.0);
    }

    if target_uv.x < -edge_padding_uv.x - blur_reach_uv.x ||
        target_uv.x > 1.0 + edge_padding_uv.x + blur_reach_uv.x ||
        target_uv.y < -edge_padding_uv.y - blur_reach_uv.y ||
        target_uv.y > 1.0 + edge_padding_uv.y + blur_reach_uv.y
    {
        return shadow_color;
    }

    if (border_coverage > 0.001) {
        let border_color = vec4<f32>(
            uniforms.border_color.xyz,
            border_coverage * uniforms.border_color.w
        );
        return composite_source_over(border_color, shadow_color);
    }

    // Outside the card the blur can still land content (the smear escapes the
    // card edge along the motion), so only take the fast exit when inactive.
    if shape_coverage <= 0.001 && !blur_active {
        return shadow_color;
    }

    let shrink = shrink_ring(crop_bounds_uv);
    let detail = detail_amount(crop_bounds_uv);
    let sample_target_uv = clamp(target_uv, vec2<f32>(0.0), vec2<f32>(1.0));
    var base_color: vec4<f32>;
    if detail > 0.0 {
        base_color = sample_detail(sample_target_uv, crop_bounds_uv, shrink, detail);
    } else {
        base_color = sample_layer(sample_target_uv, crop_bounds_uv, shrink);
    }
    base_color.a = base_color.a * shape_coverage * uniforms.opacity;

    let zoom_amount = uniforms.motion_blur_params.z;

    if !blur_active {
        return composite_source_over(apply_color_grade(base_color, target_uv, p), shadow_color);
    }

    // Length-based semantics: the user amount is baked into the LENGTH of
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
            return composite_source_over(apply_color_grade(base_color, target_uv, p), shadow_color);
        }

        // 21-tap box along [0, +v]: matches the reference directional filter
        // (kernel 21 with offset -|v|/2, which anchors the span at the pixel).
        var accum = vec3<f32>(0.0);
        var alpha_sum = 0.0;
        let k = 20.0;

        for (var i = 0; i <= 20; i = i + 1) {
            let sample_uv = target_uv + velocity_uv * (f32(i) / k);
            var tap = sample_layer(sample_uv, crop_bounds_uv, shrink);
            tap = apply_rounded_corners(tap, sample_uv);
            accum += tap.rgb * tap.a;
            alpha_sum += tap.a;
        }

        let out_alpha = (alpha_sum / 21.0) * uniforms.opacity;
        if out_alpha <= 0.0001 || alpha_sum <= 0.0001 {
            return shadow_color;
        }
        var smeared = vec4(accum / alpha_sum, out_alpha);
        if detail > 0.0 {
            smeared = settle_into_detail(
                smeared,
                base_color.rgb - sample_layer(sample_target_uv, crop_bounds_uv, shrink).rgb,
                velocity_uv,
            );
        }
        return composite_source_over(
            apply_color_grade(smeared, target_uv, p),
            shadow_color
        );
    }

    let zoom_center = uniforms.motion_blur_zoom_center;
    let dir = zoom_center - target_uv;
    let center_dist = length(dir);
    if center_dist < 1e-4 || zoom_amount < 1e-4 {
        return composite_source_over(apply_color_grade(base_color, target_uv, p), shadow_color);
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

        var tap = sample_layer(sample_uv, crop_bounds_uv, shrink);
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
    var smeared = vec4(accum / alpha_sum, out_alpha);
    if detail > 0.0 {
        smeared = settle_into_detail(
            smeared,
            base_color.rgb - sample_layer(sample_target_uv, crop_bounds_uv, shrink).rgb,
            scaled_dir,
        );
    }
    return composite_source_over(
        apply_color_grade(smeared, target_uv, p),
        shadow_color
    );
}

fn sample_texture(uv: vec2<f32>, crop_bounds_uv: vec4<f32>) -> vec4<f32> {
    let plain = sample_frame(uv, crop_bounds_uv);
    let mix_amount = uniforms.enhance_params.x;
    if mix_amount <= 0.0 {
        return plain;
    }
    if uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 {
        return plain;
    }
    let region_px = uniforms.target_bounds.xy + uv * uniforms.target_size
        - uniforms.enhance_region.xy;
    let region_size = uniforms.enhance_region.zw;
    if any(region_px < vec2<f32>(0.0)) || any(region_px > region_size) {
        return plain;
    }
    let texel = clamp(region_px, vec2<f32>(0.5), max(region_size - vec2<f32>(0.5), vec2<f32>(0.5)));
    let enhanced = textureSampleLevel(
        enhanced_texture,
        frame_sampler,
        texel / vec2<f32>(textureDimensions(enhanced_texture)),
        0.0
    );
    return vec4<f32>(mix(plain.rgb, enhanced.rgb, mix_amount), plain.a);
}

fn sample_frame(uv: vec2<f32>, crop_bounds_uv: vec4<f32>) -> vec4<f32> {
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

        if uniforms.preserve_source_alpha > 0.5 && center_sample.a < 0.999 {
            if !is_downscaling {
                return center_sample;
            }

            let footprint = scale_ratio / uniforms.frame_size * 0.5;
            let left = textureSampleLevel(
                frame_texture, frame_sampler,
                clamp(cropped_uv - vec2<f32>(footprint.x, 0.0), safe_min, safe_max), 0.0
            );
            let right = textureSampleLevel(
                frame_texture, frame_sampler,
                clamp(cropped_uv + vec2<f32>(footprint.x, 0.0), safe_min, safe_max), 0.0
            );
            let top = textureSampleLevel(
                frame_texture, frame_sampler,
                clamp(cropped_uv - vec2<f32>(0.0, footprint.y), safe_min, safe_max), 0.0
            );
            let bottom = textureSampleLevel(
                frame_texture, frame_sampler,
                clamp(cropped_uv + vec2<f32>(0.0, footprint.y), safe_min, safe_max), 0.0
            );
            let alpha_sum = center_sample.a * 4.0 + left.a + right.a + top.a + bottom.a;
            let color_sum = center_sample.rgb * center_sample.a * 4.0
                + left.rgb * left.a + right.rgb * right.a + top.rgb * top.a + bottom.rgb * bottom.a;
            return vec4<f32>(color_sum / max(alpha_sum, 0.0001), alpha_sum * 0.125);
        }

        if is_downscaling {
            // Four bilinear taps a quarter of the footprint off centre cover
            // the source texels under the output pixel, which one tap plus an
            // unsharp mask skipped: text stops aliasing and 1 px lines stop
            // turning into moire, for one tap fewer than that mask.
            let reach = scale_ratio / uniforms.frame_size * 0.25;
            let p0 = clamp(cropped_uv - reach, safe_min, safe_max);
            let p1 = clamp(cropped_uv + reach, safe_min, safe_max);
            let p2 = clamp(cropped_uv + vec2<f32>(reach.x, -reach.y), safe_min, safe_max);
            let p3 = clamp(cropped_uv + vec2<f32>(-reach.x, reach.y), safe_min, safe_max);

            if uniforms.preserve_source_alpha > 0.5 {
                // Straight-alpha sources (background removal, transparent
                // images) keep their old colour under transparent texels. A
                // hardware bilinear tap mixes that colour in, so these taps
                // interpolate premultiplied texels instead.
                let sum = sample_premultiplied(p0) + sample_premultiplied(p1)
                    + sample_premultiplied(p2) + sample_premultiplied(p3);
                return vec4(sum.rgb / max(sum.a, 0.0001), sum.a * 0.25);
            }

            let box_sum = textureSample(frame_texture, frame_sampler, p0).rgb
                + textureSample(frame_texture, frame_sampler, p1).rgb
                + textureSample(frame_texture, frame_sampler, p2).rgb
                + textureSample(frame_texture, frame_sampler, p3).rgb;
            return vec4(box_sum * 0.25, out_alpha);
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

// The filter for opaque layers shrunk more than 2.2x, such as a Retina or 4K
// recording in a 720p export, the camera bubble or the editor preview. There
// the 2x2 box in sample_texture() covers too little of the output pixel's
// footprint: its four taps share two rows and two columns, so 1 px lines and
// text strokes alias. Turning the ring towards 22 degrees puts every tap on its
// own row and column, widening it covers more of the footprint, and the centre
// tap that sample_texture() reads anyway keeps it from going soft. Below 2.2x
// the box is already as good as five samples get, so those layers render
// exactly as before. Worked out once per pixel and shared by the still sample
// and every motion blur tap, so detail doesn't change when blur starts.
struct ShrinkRing {
    enabled: bool,
    // Tap offsets in source UV: (near.x, far.y) and its quarter turns.
    near: vec2<f32>,
    far: vec2<f32>,
    center_weight: f32,
};

fn shrink_ring(crop_bounds_uv: vec4<f32>) -> ShrinkRing {
    let crop_size = crop_bounds_uv.zw - crop_bounds_uv.xy;
    let scale_ratio = uniforms.frame_size * crop_size / uniforms.target_size;
    let ratio = max(scale_ratio.x, scale_ratio.y);
    if ratio <= 2.2 || uniforms.preserve_source_alpha > 0.5 {
        return ShrinkRing(false, vec2<f32>(0.0), vec2<f32>(0.0), 0.0);
    }
    // Blend from the 2x2 box at 2.2x (45 degrees, a quarter footprint on each
    // axis) to the full ring at 2.8x, so a zoom passing through doesn't pop.
    let blend = smoothstep(2.2, 2.8, ratio);
    let angle = radians(45.0 - 23.0 * blend);
    let radius = 0.35355 + 0.09645 * blend;
    // One output pixel, in source UV.
    let footprint = scale_ratio / uniforms.frame_size;
    return ShrinkRing(
        true,
        footprint * (radius * sin(angle)),
        footprint * (radius * cos(angle)),
        0.15 * blend,
    );
}

fn sample_layer(uv: vec2<f32>, crop_bounds_uv: vec4<f32>, ring: ShrinkRing) -> vec4<f32> {
    if !ring.enabled || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 {
        return sample_texture(uv, crop_bounds_uv);
    }

    var sample_uv = uv;
    if uniforms.mirror_x != 0.0 {
        sample_uv.x = 1.0 - sample_uv.x;
    }
    let crop_size = crop_bounds_uv.zw - crop_bounds_uv.xy;
    let texel_offset = 1.0 / uniforms.frame_size;
    let safe_min = crop_bounds_uv.xy + texel_offset;
    let safe_max = crop_bounds_uv.zw - texel_offset;
    let center = clamp(sample_uv * crop_size + crop_bounds_uv.xy, safe_min, safe_max);
    let near = ring.near;
    let far = ring.far;
    let taps = sample_clamped(center + vec2<f32>(near.x, far.y), safe_min, safe_max)
        + sample_clamped(center + vec2<f32>(-far.x, near.y), safe_min, safe_max)
        + sample_clamped(center - vec2<f32>(near.x, far.y), safe_min, safe_max)
        + sample_clamped(center + vec2<f32>(far.x, -near.y), safe_min, safe_max);
    let color = mix(taps * 0.25, sample_clamped(center, safe_min, safe_max), ring.center_weight);
    return vec4(color, 1.0);
}

// How much of Enhance quality's 8-tap filter an opaque layer gets: none
// unless the option is on, fading in from 1:1 to a 1.05x shrink so a zoom
// passing full size doesn't change sharpness suddenly, and handing over to
// shrink_ring() from 2.2x to 2.8x, which keeps 1 px detail better there. Zero
// leaves the layer exactly as without the option.
fn detail_amount(crop_bounds_uv: vec4<f32>) -> f32 {
    if uniforms.enhance_params.y < 0.5 || uniforms.preserve_source_alpha > 0.5 {
        return 0.0;
    }
    let crop_size = crop_bounds_uv.zw - crop_bounds_uv.xy;
    let scale_ratio = uniforms.frame_size * crop_size / uniforms.target_size;
    let ratio = max(scale_ratio.x, scale_ratio.y);
    return smoothstep(1.0, 1.05, ratio) * (1.0 - smoothstep(2.2, 2.8, ratio));
}

// Enhance quality's filter for an opaque screen drawn smaller than its source,
// such as a Retina or 4K recording in a 1080p or 2160p export. Four bilinear
// taps on a ring turned 20 degrees average the texels under the output pixel,
// no two on the same row or column. Four more on a wider cross are subtracted
// from that average, like the negative lobes of a cubic, to give back the
// sharpness the averaging takes away. Eight reads against sample_layer()'s
// four or five, mixed with it by `amount` from detail_amount().
fn sample_detail(
    uv: vec2<f32>,
    crop_bounds_uv: vec4<f32>,
    ring: ShrinkRing,
    amount: f32,
) -> vec4<f32> {
    if uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 {
        return sample_layer(uv, crop_bounds_uv, ring);
    }

    var sample_uv = uv;
    if uniforms.mirror_x != 0.0 {
        sample_uv.x = 1.0 - sample_uv.x;
    }
    let crop_size = crop_bounds_uv.zw - crop_bounds_uv.xy;
    let scale_ratio = uniforms.frame_size * crop_size / uniforms.target_size;
    let ratio = max(scale_ratio.x, scale_ratio.y);
    let texel_offset = 1.0 / uniforms.frame_size;
    let safe_min = crop_bounds_uv.xy + texel_offset;
    let safe_max = crop_bounds_uv.zw - texel_offset;
    let center = clamp(sample_uv * crop_size + crop_bounds_uv.xy, safe_min, safe_max);

    // One output pixel, in source UV.
    let footprint = scale_ratio / uniforms.frame_size;
    let radius = clamp(0.27 + 0.6 * (ratio - 1.0), 0.27, 0.4);
    // sin and cos of 20 degrees.
    let near = footprint * (radius * 0.34202);
    let far = footprint * (radius * 0.93969);
    let average = (sample_clamped(center + vec2<f32>(near.x, far.y), safe_min, safe_max)
        + sample_clamped(center + vec2<f32>(-far.x, near.y), safe_min, safe_max)
        + sample_clamped(center - vec2<f32>(near.x, far.y), safe_min, safe_max)
        + sample_clamped(center + vec2<f32>(far.x, -near.y), safe_min, safe_max)) * 0.25;

    let sharpen = clamp(0.52 - 0.15 * ratio, 0.0, 0.36);
    let reach = footprint * 1.35;
    let cross = sample_clamped(center + vec2<f32>(reach.x, 0.0), safe_min, safe_max)
        + sample_clamped(center - vec2<f32>(reach.x, 0.0), safe_min, safe_max)
        + sample_clamped(center + vec2<f32>(0.0, reach.y), safe_min, safe_max)
        + sample_clamped(center - vec2<f32>(0.0, reach.y), safe_min, safe_max);
    let detail = clamp(average + (average - cross * 0.25) * sharpen, vec3<f32>(0.0), vec3<f32>(1.0));
    if amount >= 1.0 {
        return vec4(detail, 1.0);
    }
    return vec4(mix(sample_layer(uv, crop_bounds_uv, ring).rgb, detail, amount), 1.0);
}

// Blur taps keep sample_layer(): the smear hides the finer filter and there
// are 13 to 21 of them. A smear under two output pixels still looks sharp, so
// it gets the detail the still sample adds over sample_layer() (`detail`,
// already weighted by detail_amount()), fading out as the smear grows. A
// near-zero smear then matches the still sample and the end of a zoom
// doesn't snap into focus.
fn settle_into_detail(smeared: vec4<f32>, detail: vec3<f32>, smear_uv: vec2<f32>) -> vec4<f32> {
    let smear_px = length(smear_uv * uniforms.target_size);
    let settled = smeared.rgb + detail * (1.0 - smoothstep(0.5, 2.0, smear_px));
    return vec4(clamp(settled, vec3<f32>(0.0), vec3<f32>(1.0)), smeared.a);
}

fn sample_clamped(uv: vec2<f32>, safe_min: vec2<f32>, safe_max: vec2<f32>) -> vec3<f32> {
    return textureSampleLevel(frame_texture, frame_sampler, clamp(uv, safe_min, safe_max), 0.0).rgb;
}

// Bilinear sample of the frame as premultiplied colour.
fn sample_premultiplied(uv: vec2<f32>) -> vec4<f32> {
    let size = vec2<i32>(textureDimensions(frame_texture));
    let position = uv * vec2<f32>(size) - vec2<f32>(0.5);
    let base = floor(position);
    let fraction = position - base;
    let origin = vec2<i32>(base);
    let last = size - 1;
    let t00 = textureLoad(frame_texture, clamp(origin, vec2<i32>(0), last), 0);
    let t10 = textureLoad(frame_texture, clamp(origin + vec2<i32>(1, 0), vec2<i32>(0), last), 0);
    let t01 = textureLoad(frame_texture, clamp(origin + vec2<i32>(0, 1), vec2<i32>(0), last), 0);
    let t11 = textureLoad(frame_texture, clamp(origin + vec2<i32>(1, 1), vec2<i32>(0), last), 0);
    let top = mix(
        vec4(t00.rgb * t00.a, t00.a),
        vec4(t10.rgb * t10.a, t10.a),
        fraction.x
    );
    let bottom = mix(
        vec4(t01.rgb * t01.a, t01.a),
        vec4(t11.rgb * t11.a, t11.a),
        fraction.x
    );
    return mix(top, bottom, fraction.y);
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
