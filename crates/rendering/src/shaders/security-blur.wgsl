// struct BlurUniforms {
//     rect: vec4<f32>,
//     noise_seed: vec4<f32>,
//     blur_strength: f32,
//     _pad: vec4<f32>,
// }

// @group(0) @binding(0) var img_sampler: sampler;
// @group(0) @binding(1) var img_texture: texture_2d<f32>;
// @group(0) @binding(2) var<uniform> uniforms: BlurUniforms;

// @vertex
// fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
//     var pos = array<vec2<f32>, 6>(
//         vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
//         vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
//     );
//     return vec4<f32>(pos[vertex_index], 0.0, 1.0);
// }

// fn hash(p: vec2<f32>) -> f32 {
//     var p3 = fract(vec3<f32>(p.xyx) * vec3<f32>(.1031, .1030, .0973));
//     p3 += dot(p3, p3.yxz + 33.33);
//     return fract((p3.x + p3.y) * p3.z);
// }

// fn noise2D(p: vec2<f32>) -> f32 {
//     let i = floor(p);
//     let f = fract(p);

//     let a = hash(i);
//     let b = hash(i + vec2<f32>(1.0, 0.0));
//     let c = hash(i + vec2<f32>(0.0, 1.0));
//     let d = hash(i + vec2<f32>(1.0, 1.0));

//     let u = f * f * (3.0 - 2.0 * f);
//     return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
// }

// fn is_in_rect(pos: vec2<f32>) -> bool {
//     let rect_min = uniforms.rect.xy;
//     let rect_max = uniforms.rect.xy + uniforms.rect.zw;
//     return pos.x >= rect_min.x && pos.x <= rect_max.x &&
//            pos.y >= rect_min.y && pos.y <= rect_max.y;
// }

// // Downsample pass
// @fragment
// fn fs_downsample(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
//     let tex_size = vec2<f32>(textureDimensions(img_texture, 0));
//     let uv = pos.xy / tex_size;

//     if (!is_in_rect(pos.xy)) {
//         return textureSample(img_texture, img_sampler, uv);
//     }

//     // Calculate downsampling factor based on blur strength
//     let scale_factor = max(uniforms.blur_strength * 0.25, 1.0);

//     // Sample multiple pixels for better quality downsampling
//     let texel_size = 1.0 / tex_size;
//     var color = vec4<f32>(0.0);

//     // 4x4 box filter
//     for (var y = -1.5; y <= 1.5; y += 1.0) {
//         for (var x = -1.5; x <= 1.5; x += 1.0) {
//             let offset = vec2<f32>(x, y) * scale_factor;
//             color += textureSample(img_texture, img_sampler, uv + offset * texel_size);
//         }
//     }

//     return color / 16.0;
// }

// // Upsample with blur pass
// @fragment
// fn fs_upsample(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
//     let tex_size = vec2<f32>(textureDimensions(img_texture, 0));
//     let uv = pos.xy / tex_size;

//     if (!is_in_rect(pos.xy)) {
//         return textureSample(img_texture, img_sampler, uv);
//     }

//     // Add some noise variation to the sampling
//     let noise_scale = uniforms.blur_strength * 0.02;
//     let noise_offset = vec2<f32>(
//         noise2D(pos.xy * 0.1 + uniforms.noise_seed.xy),
//         noise2D(pos.xy * 0.1 + uniforms.noise_seed.zw)
//     ) * noise_scale;

//     // Sample with bilinear filtering (handled by the sampler)
//     let color = textureSample(img_texture, img_sampler, uv + noise_offset);

//     // Smooth transition between blur and original at the edges
//     let edge_feather = 0.1;
//     let rect_min = uniforms.rect.xy;
//     let rect_max = uniforms.rect.xy + uniforms.rect.zw;

//     let dx = min(pos.x - rect_min.x, rect_max.x - pos.x) / edge_feather;
//     let dy = min(pos.y - rect_min.y, rect_max.y - pos.y) / edge_feather;
//     let fade = min(min(dx, dy), 1.0);

//     let original = textureSample(img_texture, img_sampler, uv);
//     return mix(original, color, fade);
// }

struct Settings {
    filter_size : u32,
};

struct Orientation {
    vertical : u32,
};

struct Kernel {
  sum: f32,
  values : array<f32>,
};

@group(0) @binding(0) var<uniform> settings : Settings;
@group(0) @binding(1) var<storage, read> kernel : Kernel;
@group(1) @binding(0) var input_texture : texture_2d<f32>;
@group(1) @binding(1) var output_texture : texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(2) var<uniform> orientation: Orientation;

@compute
@workgroup_size(128)
fn main(
  @builtin(global_invocation_id) global_id : vec3<u32>,
) {
    let filter_radius = i32((settings.filter_size - 1u) / 2u);
    let filter_size = i32(settings.filter_size);
    let dimensions = textureDimensions(input_texture);
    var position = vec2<i32>(global_id.xy);
    if (orientation.vertical == 0u) {
        position = position.yx;
    }

    if(position.x >= dimensions.x || position.y >= dimensions.y) {
        return;
    }

    let original = textureLoad(input_texture, position, 0);
    var color : vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 0.0);

    for (var i : i32 = 0; i < filter_size; i = i + 1) {
        if (orientation.vertical > 0u) {
            let y = position.y - filter_radius + i;
            color = color + kernel.values[i] * textureLoad(input_texture, vec2<i32>(position.x, y), 0);
        } else {
            let x = position.x - filter_radius + i;
            color = color + kernel.values[i] * textureLoad(input_texture, vec2<i32>(x, position.y), 0);
        }
    }
    color = color / kernel.sum;

    textureStore(output_texture, position, color);
}
