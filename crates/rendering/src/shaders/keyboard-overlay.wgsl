struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct Uniforms {
    output_size: vec2<f32>,
    _padding0: vec2<f32>,
    rect: vec4<f32>,
    fill_color: vec4<f32>,
    border_color: vec4<f32>,
    shadow_color: vec4<f32>,
    radius_feather: vec2<f32>,
    _padding1: vec2<f32>,
};

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

fn sdf_round_rect(point: vec2<f32>, center: vec2<f32>, half_size: vec2<f32>, radius: f32) -> f32 {
    let q = abs(point - center) - (half_size - vec2<f32>(radius, radius));
    return length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 4>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(1.0, 1.0)
    );

    var uvs = array<vec2<f32>, 4>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0)
    );

    var out: VertexOutput;
    out.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
    out.uv = uvs[vertex_index];
    return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let screen_pos = vec2<f32>(
        input.uv.x * uniforms.output_size.x,
        (1.0 - input.uv.y) * uniforms.output_size.y
    );

    let rect_min = uniforms.rect.xy;
    let rect_max = uniforms.rect.zw;
    let rect_center = (rect_min + rect_max) * 0.5;
    let half_size = (rect_max - rect_min) * 0.5;
    let radius = max(uniforms.radius_feather.x, 0.0);
    let feather = max(uniforms.radius_feather.y, 0.001);

    let dist = sdf_round_rect(screen_pos, rect_center, half_size, radius);

    let fill_alpha = 1.0 - smoothstep(0.0, feather, dist);
    let border_width = 1.0;
    let border_alpha = (1.0 - smoothstep(-border_width, 0.0, dist)) * fill_alpha;

    let shadow_dist = sdf_round_rect(
        screen_pos,
        rect_center + vec2<f32>(0.0, 2.0),
        half_size + vec2<f32>(1.0, 1.0),
        radius + 1.0
    );
    let shadow_alpha = 1.0 - smoothstep(0.0, feather * 3.0, shadow_dist);

    let shadow = vec4<f32>(
        uniforms.shadow_color.rgb,
        uniforms.shadow_color.a * shadow_alpha
    );

    let fill = vec4<f32>(
        uniforms.fill_color.rgb,
        uniforms.fill_color.a * fill_alpha
    );

    let border = vec4<f32>(
        uniforms.border_color.rgb,
        uniforms.border_color.a * border_alpha
    );

    let base = shadow + fill * (1.0 - shadow.a);
    return base + border * (1.0 - base.a);
}
