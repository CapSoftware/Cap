struct BlurUniforms {
    rect: vec4<f32>,
    noise_seed: vec4<f32>,
    blur_strength: f32,
    _pad: vec4<f32>,
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

fn noise2D(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);

    let a = hash(i);
    let b = hash(i + vec2<f32>(1.0, 0.0));
    let c = hash(i + vec2<f32>(0.0, 1.0));
    let d = hash(i + vec2<f32>(1.0, 1.0));

    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p: vec2<f32>) -> f32 {
    var sum = 0.0;
    var amp = 0.5;
    var freq = 1.0;

    for(var i = 0; i < 4; i++) {
        sum += noise2D(p * freq) * amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    return sum;
}

fn calculate_blur_params(pos: vec2<f32>, tex_size: vec2<f32>) -> vec2<f32> {
    // Generate organic pattern using multiple noise layers
    let normalized_pos = pos / tex_size;

    // Create multiple frequency patterns
    let base_pattern = fbm(normalized_pos * 4.0 + uniforms.noise_seed.xy);
    let detail_pattern = fbm(normalized_pos * 8.0 + uniforms.noise_seed.zw);

    // Create varying blur strength
    let pattern = mix(base_pattern, detail_pattern, 0.5);
    let strength = pattern * uniforms.blur_strength;

    // Calculate local radius based on pattern
    let radius = mix(10.0, 30.0, pattern) * uniforms.blur_strength;

    return vec2<f32>(radius, strength);
}

fn gaussian(x: f32, sigma: f32) -> f32 {
    let pi = 3.14159265359;
    return (1.0 / (sigma * sqrt(2.0 * pi))) * exp(-(x * x) / (2.0 * sigma * sigma));
}

fn get_noise_offset(pos: vec2<f32>, seed: vec4<f32>, sigma: f32, strength: f32) -> vec2<f32> {
    let noise_x = noise2D(pos * 0.1 + seed.xy);
    let noise_y = noise2D(pos * 0.1 + seed.zw);
    let noise_scale = min(sigma * 0.04 * strength, 0.08);
    return vec2<f32>(noise_x * 2.0 - 1.0, noise_y * 2.0 - 1.0) * noise_scale;
}

fn sample_with_blur(uv: vec2<f32>, offset: vec2<f32>, pos: vec2<f32>, params: vec2<f32>, texel_size: vec2<f32>) -> vec4<f32> {
    let noise_offset = get_noise_offset(pos + offset, uniforms.noise_seed, params.x, params.y);
    return textureSample(img_texture, img_sampler, uv + (offset + noise_offset) * texel_size);
}

@fragment
fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let tex_size = vec2<f32>(textureDimensions(img_texture, 0));
    let uv = vec2<f32>(pos.xy / tex_size);
    let texel_size = 1.0 / tex_size;

    // Check if within rect bounds
    let pixel_pos = pos.xy;
    let rect_min = uniforms.rect.xy;
    let rect_max = uniforms.rect.xy + uniforms.rect.zw;

    if (pixel_pos.x < rect_min.x || pixel_pos.x > rect_max.x ||
        pixel_pos.y < rect_min.y || pixel_pos.y > rect_max.y) {
        return textureSample(img_texture, img_sampler, uv);
    }

    // Get organic blur parameters for current position
    let blur_params = calculate_blur_params(pos.xy, tex_size);
    let local_radius = blur_params.x;
    let local_strength = blur_params.y;

    // Calculate adaptive sigma based on local parameters
    let sigma = max(local_radius / 2.0, 0.1) * local_strength;

    let sample_count = 32;  // High quality sampling
    var total_weight = gaussian(0.0, sigma);

    // Center sample with organic noise
    let noise_offset = get_noise_offset(pos.xy, uniforms.noise_seed, sigma, local_strength);
    var color = textureSample(img_texture, img_sampler, uv + noise_offset * texel_size) * total_weight;

    // Spiral sampling pattern with varying radius
    for (var i = 1; i < sample_count; i++) {
        let offset = f32(i);
        let weight = gaussian(offset, sigma);

        // Golden ratio angle for better distribution
        let golden_angle = 2.399963229728653; // (√5 + 1)/2 * π

        for (var j = 0; j < 8; j++) {
            let angle = golden_angle * f32(i) + (f32(j) * 0.785398);
            let sample_offset = vec2<f32>(
                cos(angle) * offset,
                sin(angle) * offset
            );

            color += sample_with_blur(uv, sample_offset, pos.xy, blur_params, texel_size) * weight;
        }

        total_weight += 8.0 * weight;
    }

    // Smooth transition between blur and original
    let final_color = color / total_weight;
    return mix(
        textureSample(img_texture, img_sampler, uv),
        final_color,
        smoothstep(0.0, 0.2, local_strength)
    );
}
