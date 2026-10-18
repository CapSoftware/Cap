struct ImageUniforms {
    center_size: vec4<f32>,
    rotation_opacity_radius: vec4<f32>,
    flips: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: ImageUniforms;
@group(0) @binding(1) var image_texture: texture_2d<f32>;
@group(0) @binding(2) var image_sampler: sampler;

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    return vec4<f32>(positions[index], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let offset = position.xy - uniforms.center_size.xy;
    let cosine = uniforms.rotation_opacity_radius.x;
    let sine = uniforms.rotation_opacity_radius.y;
    let local = vec2<f32>(
        cosine * offset.x + sine * offset.y,
        -sine * offset.x + cosine * offset.y,
    );
    let uv = local / uniforms.center_size.zw + vec2<f32>(0.5);
    let flipped_uv = select(uv, vec2<f32>(1.0) - uv, uniforms.flips.xy > vec2<f32>(0.5));
    let color = textureSample(image_texture, image_sampler, flipped_uv);
    let radius = uniforms.rotation_opacity_radius.w;
    let q = abs(local) - uniforms.center_size.zw * 0.5 + vec2<f32>(radius);
    let distance = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
    let feather = max(fwidth(distance), 0.0001);
    let coverage = 1.0 - smoothstep(-feather, 0.0, distance);
    let inside = all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0));
    return select(vec4<f32>(0.0), color, inside)
        * coverage * uniforms.rotation_opacity_radius.z;
}
