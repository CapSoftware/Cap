struct BlurUniforms {
    rect: vec4<f32>,      // x, y, width, height
    direction: vec2<f32>,
    blur_radius: f32,
    _pad: f32,
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

fn gaussian(x: f32, sigma: f32) -> f32 {
    let pi = 3.14159265359;
    return (1.0 / (sigma * sqrt(2.0 * pi))) * exp(-(x * x) / (2.0 * sigma * sigma));
}

@fragment
fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let tex_size = vec2<f32>(textureDimensions(img_texture, 0));
    let uv = vec2<f32>(pos.xy / tex_size);

    // Check if current pixel is within blur rectangle
    let pixel_pos = pos.xy;
    let rect_min = uniforms.rect.xy;
    let rect_max = uniforms.rect.xy + uniforms.rect.zw;

    if (pixel_pos.x < rect_min.x || pixel_pos.x > rect_max.x ||
        pixel_pos.y < rect_min.y || pixel_pos.y > rect_max.y) {
        // Outside blur region - return original color
        return textureSample(img_texture, img_sampler, uv);
    }

    // Inside blur region - apply blur
    let texel_size = 1.0 / tex_size;
    let offset = uniforms.direction * texel_size;

    // Calculate sigma based on blur radius (radius is roughly 3*sigma in a gaussian)
    let sigma = max(uniforms.blur_radius / 3.0, 0.01);

    // Calculate weights for samples
    let sample_count = 15; // Increase sample count for smoother blur
    var total_weight = gaussian(0.0, sigma);
    var color = textureSample(img_texture, img_sampler, uv) * total_weight;

    // Sample in both directions from center
    for (var i = 1; i < sample_count; i++) {
        let weight = gaussian(f32(i), sigma);
        let offset_i = offset * f32(i);

        color += textureSample(img_texture, img_sampler, uv + offset_i) * weight;
        color += textureSample(img_texture, img_sampler, uv - offset_i) * weight;
        total_weight += 2.0 * weight;
    }

    // Normalize by total weight
    return color / total_weight;
}
