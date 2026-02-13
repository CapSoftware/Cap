struct Uniforms {
    inverse_mvp: mat4x4<f32>,
    output_size: vec2<f32>,
    plane_half_size: vec2<f32>,
    shadow_opacity: f32,
    rounding_px: f32,
    enabled: f32,
    _padding: f32,
    background_color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var source_texture: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 4>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, 1.0)
    );

    var out: VertexOutput;
    let pos = positions[vertex_index];
    out.position = vec4<f32>(pos, 0.0, 1.0);
    out.uv = (pos + 1.0) * 0.5;
    out.uv.y = 1.0 - out.uv.y;
    return out;
}

fn unproject(ndc: vec3<f32>) -> vec3<f32> {
    let clip = vec4<f32>(ndc, 1.0);
    let world = uniforms.inverse_mvp * clip;
    return world.xyz / world.w;
}

fn ray_plane_intersect(ray_origin: vec3<f32>, ray_dir: vec3<f32>) -> vec2<f32> {
    let t = -ray_origin.z / ray_dir.z;
    if t < 0.0 {
        return vec2<f32>(-999.0, -999.0);
    }
    let hit = ray_origin + ray_dir * t;
    return hit.xy;
}

fn sdf_rounded_rect(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - b + vec2<f32>(r);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    if uniforms.enabled < 0.5 {
        return textureSample(source_texture, source_sampler, in.uv);
    }

    let ndc_x = in.uv.x * 2.0 - 1.0;
    let ndc_y = (1.0 - in.uv.y) * 2.0 - 1.0;

    let near_point = unproject(vec3<f32>(ndc_x, ndc_y, -1.0));
    let far_point = unproject(vec3<f32>(ndc_x, ndc_y, 1.0));
    let ray_dir = normalize(far_point - near_point);

    let hit_xy = ray_plane_intersect(near_point, ray_dir);

    let plane_uv = hit_xy / (uniforms.plane_half_size * 2.0) + 0.5;

    let shadow_plane_z = -0.005;
    let shadow_t = (shadow_plane_z - near_point.z) / ray_dir.z;
    let shadow_hit = near_point + ray_dir * shadow_t;
    let shadow_uv_offset = shadow_hit.xy / (uniforms.plane_half_size * 2.0) + 0.5;
    let shadow_dist_to_center = abs(shadow_uv_offset - 0.5) * 2.0;
    let shadow_falloff = max(shadow_dist_to_center.x, shadow_dist_to_center.y);
    let shadow_alpha = (1.0 - smoothstep_custom(0.9, 1.3, shadow_falloff)) * uniforms.shadow_opacity;

    let half_size = uniforms.plane_half_size;
    let rounding_normalized = uniforms.rounding_px / min(uniforms.output_size.x, uniforms.output_size.y) * 2.0;

    let centered_hit = hit_xy;
    let dist = sdf_rounded_rect(centered_hit, half_size, rounding_normalized * min(half_size.x, half_size.y));

    let aa_width = max(fwidth(dist), 0.002);
    let coverage = 1.0 - smoothstep_custom(0.0, aa_width * 2.0, dist);

    if plane_uv.x >= 0.0 && plane_uv.x <= 1.0 && plane_uv.y >= 0.0 && plane_uv.y <= 1.0 && coverage > 0.01 {
        let flipped_uv = vec2<f32>(plane_uv.x, 1.0 - plane_uv.y);
        let color = textureSample(source_texture, source_sampler, flipped_uv);
        let final_color = vec4<f32>(color.rgb, color.a * coverage);
        return blend_over(vec4<f32>(0.0, 0.0, 0.0, shadow_alpha), final_color);
    }

    if shadow_t > 0.0 && shadow_alpha > 0.01 {
        return vec4<f32>(0.0, 0.0, 0.0, shadow_alpha * 0.5);
    }

    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}

fn smoothstep_custom(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

fn blend_over(below: vec4<f32>, above: vec4<f32>) -> vec4<f32> {
    let a = above.a + below.a * (1.0 - above.a);
    if a < 0.001 {
        return vec4<f32>(0.0);
    }
    let rgb = (above.rgb * above.a + below.rgb * below.a * (1.0 - above.a)) / a;
    return vec4<f32>(rgb, a);
}
