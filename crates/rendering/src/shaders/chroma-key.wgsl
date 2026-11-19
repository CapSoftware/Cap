struct Uniforms {
    key_color: vec4<f32>,
    // (tolerance, softness, spill, unused).
    levels: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var source_texture: texture_2d<f32>;

const LUMA: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    return vec4<f32>(positions[vertex_index], 0.0, 1.0);
}

// BT.709 (Cb, Cr) of gamma-encoded RGB. Luma drops out, so a darker or
// brighter patch of the same screen moves along the key's own direction.
fn chroma(rgb: vec3<f32>) -> vec2<f32> {
    let y = dot(rgb, LUMA);
    return vec2<f32>((rgb.b - y) / 1.8556, (rgb.r - y) / 1.5748);
}

fn rgb_from(y: f32, c: vec2<f32>) -> vec3<f32> {
    let r = y + 1.5748 * c.y;
    let b = y + 1.8556 * c.x;
    let g = (y - LUMA.r * r - LUMA.b * b) / LUMA.g;
    return vec3<f32>(r, g, b);
}

@fragment
fn fs_main(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {
    let color = textureLoad(source_texture, vec2<i32>(frag_coord.xy), 0);
    let tolerance = uniforms.levels.x;
    let softness = max(uniforms.levels.y, 1.0 / 255.0);
    let spill = uniforms.levels.z;

    let key = chroma(uniforms.key_color.rgb);
    let key_length = max(length(key), 0.01);
    let key_direction = key / key_length;
    let pixel = chroma(color.rgb);

    // Chroma is linear in RGB, so for a neutral subject (skin and hair sit far
    // from any screen hue) mixed with the screen, this distance is the
    // subject's share of the pixel: 0 on the screen, 1 on grey.
    let distance = length(pixel - key) / key_length;
    let ramp = clamp((distance - tolerance) / softness, 0.0, 1.0);
    let alpha = ramp * ramp * (3.0 - 2.0 * ramp);

    // Spill removal takes the key's hue out of the pixel and keeps its luma.
    // Keyed texels lose all of it, so the edge bilinear filtering blends into
    // is neutral instead of screen-coloured.
    let removal = mix(1.0, spill, alpha);
    let toward_key = max(dot(pixel, key_direction), 0.0);
    let cleaned = pixel - key_direction * toward_key * removal;
    let rgb = clamp(rgb_from(dot(color.rgb, LUMA), cleaned), vec3<f32>(0.0), vec3<f32>(1.0));

    return vec4<f32>(rgb, color.a * alpha);
}
