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
    let offset = vec2<f32>(texel_size.x, 0.0);

    let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
    var color = textureSample(img_texture, img_sampler, uv) * weights[0];

    // Unrolled loop for better performance
    color += textureSample(img_texture, img_sampler, uv + offset * 1.0) * weights[1];
    color += textureSample(img_texture, img_sampler, uv - offset * 1.0) * weights[1];

    color += textureSample(img_texture, img_sampler, uv + offset * 2.0) * weights[2];
    color += textureSample(img_texture, img_sampler, uv - offset * 2.0) * weights[2];

    color += textureSample(img_texture, img_sampler, uv + offset * 3.0) * weights[3];
    color += textureSample(img_texture, img_sampler, uv - offset * 3.0) * weights[3];

    color += textureSample(img_texture, img_sampler, uv + offset * 4.0) * weights[4];
    color += textureSample(img_texture, img_sampler, uv - offset * 4.0) * weights[4];

    return color;
}
