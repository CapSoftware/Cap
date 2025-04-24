struct BlurUniforms {
    rect: vec4<f32>,      // x, y, width, height
    noise_seed: vec4<f32>,
    blur_radius: f32,
    _pad: vec4<f32>
}

@group(0) @binding(0) var img_sampler: sampler;
@group(0) @binding(1) var img_texture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> uniforms: BlurUniforms;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
    var pos = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
        vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
    );
    return vec4<f32>(pos[vertex_index], 0.0, 1.0);
}

fn hash(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.xyx) * vec3<f32>(.1031, .1030, .0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn gaussian(x: f32, sigma: f32) -> f32 {
    let pi = 3.14159265359;
    return (1.0 / (sigma * sqrt(2.0 * pi))) * exp(-(x * x) / (2.0 * sigma * sigma));
}

fn get_noise_offset(pos: vec2<f32>, seed: vec4<f32>, sigma: f32) -> vec2<f32> {
    let noise_x = hash(pos + seed.xy) * 2.0 - 1.0;
    let noise_y = hash(pos + seed.zw) * 2.0 - 1.0;
    let noise_scale = min(sigma * 0.01, 0.02);
    return vec2<f32>(noise_x, noise_y) * noise_scale;
}

fn sample_with_blur(uv: vec2<f32>, offset: vec2<f32>, pos: vec2<f32>, noise_seed: vec4<f32>, sigma: f32, texel_size: vec2<f32>) -> vec4<f32> {
    let noise_offset = get_noise_offset(pos + offset, noise_seed, sigma);
    return textureSample(img_texture, img_sampler, uv + (offset + noise_offset) * texel_size);
}

@fragment
fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let tex_size = vec2<f32>(textureDimensions(img_texture, 0));
    let uv = vec2<f32>(pos.xy / tex_size);
    let texel_size = 1.0 / tex_size;

    // Check if current pixel is within blur rectangle
    let pixel_pos = pos.xy;
    let rect_min = uniforms.rect.xy;
    let rect_max = uniforms.rect.xy + uniforms.rect.zw;

    if (pixel_pos.x < rect_min.x || pixel_pos.x > rect_max.x ||
        pixel_pos.y < rect_min.y || pixel_pos.y > rect_max.y) {
        return textureSample(img_texture, img_sampler, uv);
    }

    // Calculate sigma based on blur radius
    let sigma = max(uniforms.blur_radius / 3.0, 0.01);

    let sample_count = 15;
    var total_weight = gaussian(0.0, sigma);

    // Center sample with noise
    let noise_offset = get_noise_offset(pos.xy, uniforms.noise_seed, sigma);
    var color = textureSample(img_texture, img_sampler, uv + noise_offset * texel_size) * total_weight;

    // Sample in both horizontal and vertical directions
    for (var i = 1; i < sample_count; i++) {
        let weight = gaussian(f32(i), sigma);
        let offset = f32(i);

        // Sample in all four diagonal directions to cover both horizontal and vertical
        color += sample_with_blur(uv, vec2<f32>( offset,  offset), pos.xy, uniforms.noise_seed, sigma, texel_size) * weight;
        color += sample_with_blur(uv, vec2<f32>(-offset,  offset), pos.xy, uniforms.noise_seed, sigma, texel_size) * weight;
        color += sample_with_blur(uv, vec2<f32>( offset, -offset), pos.xy, uniforms.noise_seed, sigma, texel_size) * weight;
        color += sample_with_blur(uv, vec2<f32>(-offset, -offset), pos.xy, uniforms.noise_seed, sigma, texel_size) * weight;

        // Sample in cardinal directions
        color += sample_with_blur(uv, vec2<f32>(offset, 0.0), pos.xy, uniforms.noise_seed, sigma, texel_size) * weight;
        color += sample_with_blur(uv, vec2<f32>(-offset, 0.0), pos.xy, uniforms.noise_seed, sigma, texel_size) * weight;
        color += sample_with_blur(uv, vec2<f32>(0.0, offset), pos.xy, uniforms.noise_seed, sigma, texel_size) * weight;
        color += sample_with_blur(uv, vec2<f32>(0.0, -offset), pos.xy, uniforms.noise_seed, sigma, texel_size) * weight;

        total_weight += 8.0 * weight; // Account for all 8 samples
    }

    return color / total_weight;
}
