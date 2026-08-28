struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct Uniforms {
    position_size: vec4<f32>,
    output_size: vec4<f32>,
    screen_bounds: vec4<f32>,
    // (r, g, b, strength).
    color: vec4<f32>,
    // (progress, opacity, quad half-extent in ring radii, unused).
    params: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var corners = array<vec2<f32>, 4>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0)
    );

    let local_uv = corners[vertex_index];
    let pos = vec2<f32>(local_uv.x, -local_uv.y);

    var adjusted_pos = uniforms.position_size.xy;
    adjusted_pos.y = uniforms.output_size.y - adjusted_pos.y;

    let final_pos = ((pos * uniforms.position_size.zw) + adjusted_pos)
        / uniforms.output_size.xy * 2.0 - 1.0;

    var output: VertexOutput;
    output.position = vec4<f32>(final_pos, 0.0, 1.0);
    output.uv = local_uv;
    return output;
}

// Same feathered display-card clip the cursor sprite uses, so a ripple whose
// click landed in a cropped-away region slides off the card edge instead of
// floating over the background.
fn screen_bounds_mask(frag_pos: vec2<f32>) -> f32 {
    let b = uniforms.screen_bounds;
    let inside = min(
        min(frag_pos.x - b.x, b.z - frag_pos.x),
        min(frag_pos.y - b.y, b.w - frag_pos.y),
    );
    return clamp(inside + 0.5, 0.0, 1.0);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let t = clamp(uniforms.params.x, 0.0, 1.0);
    let inv = 1.0 - t;

    // Distances are measured in ring radii, so R cancels out of the whole
    // profile below.
    let d = length(input.uv - vec2<f32>(0.5)) * 2.0 * uniforms.params.z;

    let r = 1.0 - inv * inv * inv;
    let w = 0.10 + 0.06 * t;

    let ring = 1.0 - smoothstep(0.0, w, abs(d - r));
    let fill = (1.0 - smoothstep(r - w, r, d)) * 0.30;

    var alpha = uniforms.color.a * pow(inv, 1.5) * (ring + fill);
    alpha *= uniforms.params.y * screen_bounds_mask(input.position.xy);
    alpha = clamp(alpha, 0.0, 1.0);

    return vec4<f32>(uniforms.color.rgb * alpha, alpha);
}
