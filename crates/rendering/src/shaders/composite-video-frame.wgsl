struct Uniforms {
    crop_bounds: vec4<f32>,
    target_bounds: vec4<f32>,
    output_size: vec2<f32>,
    frame_size: vec2<f32>,
    velocity_uv: vec2<f32>,
    target_size: vec2<f32>,
    rounding_px: f32,
    mirror_x: f32,
    motion_blur_amount: f32,
    camera_motion_blur_amount: f32,
    shadow: f32,
    shadow_size: f32,
    shadow_opacity: f32,
    shadow_blur: f32,
    opacity: f32,
    border_enabled: f32,
    border_width: f32,
    _padding1: vec2<f32>,
    border_color: vec4<f32>,
    _padding2: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var frame_texture: texture_2d<f32>;
@group(0) @binding(2) var frame_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

const SQUIRCLE_POWER: f32 = 4.5;

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

fn sdf_rounded_rect(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
    let clamped_r = clamp(r, 0.0, min(b.x, b.y));
    let q = abs(p) - b + vec2<f32>(clamped_r);
    let outside = max(q, vec2<f32>(0.0));
    let inside = min(max(q.x, q.y), 0.0);

    if clamped_r <= 0.0 {
        return length(outside) + inside;
    }

    let normalized = outside / vec2<f32>(clamped_r);
    let super_len = pow(pow(normalized.x, SQUIRCLE_POWER) + pow(normalized.y, SQUIRCLE_POWER), 1.0 / SQUIRCLE_POWER);
    let metric = super_len * clamped_r;

    return metric + inside - clamped_r;
}

@fragment
fn fs_main(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {
    let p = frag_coord.xy;
    let center = (uniforms.target_bounds.xy + uniforms.target_bounds.zw) * 0.5;
    let size = (uniforms.target_bounds.zw - uniforms.target_bounds.xy) * 0.5;
    
    let dist = sdf_rounded_rect(p - center, size, uniforms.rounding_px);

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

    let shadow_dist = sdf_rounded_rect(p - center, size, uniforms.rounding_px);

    // Apply blur and size to shadow
    let shadow_strength_final = smoothstep(shadow_size + shadow_blur, -shadow_blur, abs(shadow_dist));
    let shadow_color = vec4<f32>(0.0, 0.0, 0.0, shadow_strength_final * shadow_opacity);

    let uv = p / uniforms.output_size;
    let target_uv = (p - uniforms.target_bounds.xy) / uniforms.target_size;
    let crop_bounds_uv = vec4<f32>(uniforms.crop_bounds.xy / uniforms.frame_size, uniforms.crop_bounds.zw / uniforms.frame_size);

    let bg_color = vec4<f32>(0.0);

    if (uniforms.border_enabled > 0.0) {
        let border_outer_dist = sdf_rounded_rect(
            p - center,
            size + vec2<f32>(uniforms.border_width),
            uniforms.rounding_px + uniforms.border_width
        );
        let border_inner_dist = sdf_rounded_rect(p - center, size, uniforms.rounding_px);

        if (border_outer_dist <= 0.0 && border_inner_dist > 0.0) {
            let inner_alpha = smoothstep(-0.5, 0.5, border_inner_dist);
            let outer_alpha = 1.0 - smoothstep(-0.5, 0.5, border_outer_dist);
            let edge_alpha = inner_alpha * outer_alpha;

            let border_alpha = edge_alpha * uniforms.border_color.w;
            return vec4<f32>(uniforms.border_color.xyz, border_alpha);
        }
    }
    
    if target_uv.x < 0.0 || target_uv.x > 1.0 || target_uv.y < 0.0 || target_uv.y > 1.0 {
        return shadow_color;
    }

    var base_color = sample_texture(target_uv, crop_bounds_uv);
    base_color = apply_rounded_corners(base_color, target_uv);
    base_color.a = base_color.a * uniforms.opacity;

    let blur_amount = select(uniforms.motion_blur_amount, uniforms.camera_motion_blur_amount, uniforms.camera_motion_blur_amount > 0.0);

    if blur_amount < 0.01 {
        return mix(shadow_color, base_color, base_color.a);
    }

    let center_uv = vec2<f32>(0.5, 0.5);
    let dir = normalize(target_uv - center_uv);

    let base_samples = 16.0;
    let num_samples = i32(base_samples * smoothstep(0.0, 1.0, blur_amount));

    var accum = base_color;
    var weight_sum = 1.0;

    for (var i = 1; i < num_samples; i = i + 1) {
        let t = f32(i) / f32(num_samples);
        let dist_from_center = length(target_uv - center_uv);

        let random_offset = (rand(target_uv + vec2<f32>(t)) - 0.5) * 0.1 * smoothstep(0.0, 0.2, blur_amount);

        let base_scale = select(
            0.08,  // Regular content scale
            0.16,  // Camera scale
            uniforms.camera_motion_blur_amount > 0.0
        );
        let scale = dist_from_center * blur_amount * (base_scale + random_offset) * smoothstep(0.0, 0.1, blur_amount);

        let angle_variation = (rand(target_uv + vec2<f32>(t * 2.0)) - 0.5) * 0.1 * smoothstep(0.0, 0.2, blur_amount);
        let rotated_dir = vec2<f32>(
            dir.x * cos(angle_variation) - dir.y * sin(angle_variation),
            dir.x * sin(angle_variation) + dir.y * cos(angle_variation)
        );

        let offset = rotated_dir * scale * t;

        let sample_uv = target_uv - offset;
        if sample_uv.x >= 0.0 && sample_uv.x <= 1.0 && sample_uv.y >= 0.0 && sample_uv.y <= 1.0 {
            var sample_color = sample_texture(sample_uv, crop_bounds_uv);
            sample_color = apply_rounded_corners(sample_color, sample_uv);

            let weight = (1.0 - t) * (1.0 + random_offset * 0.2);
            accum += sample_color * weight;
            weight_sum += weight;
        }
    }

    let final_color = accum / weight_sum;
    let blurred = vec4(final_color.rgb, base_color.a);
    return mix(shadow_color, blurred, blurred.a);
}

fn sample_texture(uv: vec2<f32>, crop_bounds_uv: vec4<f32>) -> vec4<f32> {
    if uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0 {
        var sample_uv = uv;
        if uniforms.mirror_x != 0.0 {
            sample_uv.x = 1.0 - sample_uv.x;
        }

        let cropped_uv = sample_uv * (crop_bounds_uv.zw - crop_bounds_uv.xy) + crop_bounds_uv.xy;

        // Calculate downscaling ratio
        let source_size = uniforms.frame_size * (crop_bounds_uv.zw - crop_bounds_uv.xy);
        let target_size = uniforms.target_size;
        let scale_ratio = source_size / target_size;
        let is_downscaling = max(scale_ratio.x, scale_ratio.y) > 1.1;

        // Sample the center pixel
        let center_color = textureSample(frame_texture, frame_sampler, cropped_uv).rgb;

        // Apply sharpening when downscaling to preserve text clarity
        if is_downscaling {
            let texel_size = 1.0 / uniforms.frame_size;

            // Sample neighboring pixels for unsharp mask
            let offset_x = vec2<f32>(texel_size.x, 0.0);
            let offset_y = vec2<f32>(0.0, texel_size.y);

            // 4-tap sampling for edge detection
            let left = textureSample(frame_texture, frame_sampler, cropped_uv - offset_x).rgb;
            let right = textureSample(frame_texture, frame_sampler, cropped_uv + offset_x).rgb;
            let top = textureSample(frame_texture, frame_sampler, cropped_uv - offset_y).rgb;
            let bottom = textureSample(frame_texture, frame_sampler, cropped_uv + offset_y).rgb;

            // Calculate the blurred version (average of neighbors)
            let blurred = (left + right + top + bottom) * 0.25;

            // Unsharp mask: enhance the difference between center and blur
            // Strength is adaptive based on downscale ratio
            let sharpness = min(scale_ratio.x * 0.3, 0.7); // Cap at 0.7 to avoid over-sharpening
            let sharpened = center_color + (center_color - blurred) * sharpness;

            // Clamp to avoid color artifacts
            return vec4(clamp(sharpened, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
        }

        return vec4(center_color, 1.0);
    }

    return vec4(0.0);
}

fn apply_rounded_corners(current_color: vec4<f32>, target_uv: vec2<f32>) -> vec4<f32> {
    if uniforms.rounding_px <= 0.0 {
        return current_color;
    }

    let half_size = uniforms.target_size * 0.5;
    let frag_pos = target_uv * uniforms.target_size - half_size;
    let dist = sdf_rounded_rect(frag_pos, half_size, uniforms.rounding_px);

    let edge_softness = max(fwidth(dist), 0.75);
    let mask = 1.0 - smoothstep(0.0, edge_softness, dist);

    return vec4<f32>(current_color.rgb * mask, current_color.a * mask);
}

fn rand(co: vec2<f32>) -> f32 {
    return fract(sin(dot(co, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}
