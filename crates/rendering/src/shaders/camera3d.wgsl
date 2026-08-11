// 3D perspective warp for the composed content plane.
//
// The content group (frame chrome, display, cursor, notch, camera) is rendered
// into a transparent texture; this pass maps each output pixel back onto that
// texture through the inverse planar homography and composites the result over
// the untouched background with premultiplied alpha.
//
// Row layouts: inv_row0.w is unused; inv_row1.w and inv_row2.w carry the
// plane half-extents (hx, hy) — the content plane spans [-hx, hx] × [-hy, hy]
// in world units with its longest side equal to 2.

struct Camera3DUniforms {
    inv_row0: vec4<f32>,
    inv_row1: vec4<f32>,
    inv_row2: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Camera3DUniforms;
@group(0) @binding(1) var t_content: texture_2d<f32>;
@group(0) @binding(2) var s_content: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) screen_uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    // Fullscreen triangle.
    let uv = vec2<f32>(
        f32((vertex_index << 1u) & 2u),
        f32(vertex_index & 2u),
    );
    var out: VertexOutput;
    out.position = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
    out.screen_uv = vec2<f32>(uv.x, 1.0 - uv.y);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let half_extents = vec2<f32>(u.inv_row1.w, u.inv_row2.w);
    // y-up NDC of this output pixel.
    let ndc = vec3<f32>(
        in.screen_uv.x * 2.0 - 1.0,
        1.0 - in.screen_uv.y * 2.0,
        1.0,
    );

    let q = vec3<f32>(
        dot(u.inv_row0.xyz, ndc),
        dot(u.inv_row1.xyz, ndc),
        dot(u.inv_row2.xyz, ndc),
    );

    // q.z <= 0 means the ray hits the plane behind the camera (past the
    // horizon of an extreme rotation) — those pixels stay background.
    let in_front = f32(q.z > 1e-6);

    // Plane coords: X in [-hx, hx], Y in [-hy, hy] inside the content.
    let denom = select(q.z, 1e-6, abs(q.z) <= 1e-6);
    let plane = q.xy / denom;
    let content_uv = vec2<f32>(
        (plane.x / half_extents.x + 1.0) * 0.5,
        (1.0 - plane.y / half_extents.y) * 0.5,
    );

    // Analytic edge anti-aliasing: fade coverage over one output pixel.
    let width = max(fwidth(content_uv), vec2<f32>(1e-6));
    let edge = smoothstep(vec2<f32>(0.0), width, content_uv)
        * smoothstep(vec2<f32>(0.0), width, vec2<f32>(1.0) - content_uv);
    let coverage = edge.x * edge.y * in_front;

    let clamped = clamp(content_uv, vec2<f32>(0.0), vec2<f32>(1.0));
    // The content texture is premultiplied (straight-alpha layers composited
    // onto transparent black), so coverage scales the whole texel.
    let color = textureSampleLevel(t_content, s_content, clamped, 0.0);
    return color * coverage;
}
