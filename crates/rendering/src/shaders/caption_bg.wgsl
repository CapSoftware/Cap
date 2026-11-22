struct BackgroundUniforms {
    rect: vec4<f32>,
    color: vec4<f32>,
    radius: f32,
    // How dark the soft shadow under the card is (0 draws none), and how
    // bright the lit line along its top edge is.
    shadow: f32,
    edge: f32,
    _padding: f32,
    _padding2: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: BackgroundUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(1.0, 1.0),
    );

    var output: VertexOutput;
    output.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
    return output;
}

fn squircle_sdf(p: vec2<f32>, half_size: vec2<f32>, radius: f32) -> f32 {
    let adjusted_half = half_size - vec2<f32>(radius);
    let q = abs(p) - adjusted_half;
    
    if q.x <= 0.0 && q.y <= 0.0 {
        return max(q.x, q.y) - radius;
    }
    
    let corner = max(q, vec2<f32>(0.0));
    let n = 4.0;
    let corner_dist = pow(pow(corner.x, n) + pow(corner.y, n), 1.0 / n);
    
    return corner_dist - radius;
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let rect_min = uniforms.rect.xy;
    let rect_size = uniforms.rect.zw;
    let rect_center = rect_min + rect_size * 0.5;
    let radius = uniforms.radius;
    let half_size = rect_size * 0.5;

    let local = position.xy - rect_center;
    let distance = squircle_sdf(local, half_size, radius);
    
    let edge_softness = 1.5;
    let alpha = 1.0 - smoothstep(-edge_softness, edge_softness, distance);
    var card = vec4<f32>(uniforms.color.rgb, uniforms.color.a * alpha);

    if uniforms.edge > 0.0 {
        // The lit top edge the keycaps have: a fine bright line just inside
        // the upper rim, fading down the card.
        let inside = -distance;
        let line = (1.0 - smoothstep(0.0, 1.4, inside)) * alpha;
        let upper = 1.0 - smoothstep(0.0, rect_size.y * 0.5, position.y - rect_min.y);
        card = vec4<f32>(mix(card.rgb, vec3<f32>(1.0), line * upper * uniforms.edge), card.a);
    }

    if uniforms.shadow <= 0.0 {
        return card;
    }

    // A soft halo all round the card that lifts it off whatever lies behind,
    // then a wide ambient shadow and a tight contact shadow, dropped below the
    // card the way light falls on the keys above it.
    let height = rect_size.y;
    let halo_blur = max(height * 0.6, 2.0);
    let halo_d = squircle_sdf(local - vec2<f32>(0.0, height * 0.06), half_size, radius);
    let halo = (1.0 - smoothstep(-halo_blur * 0.3, halo_blur, halo_d)) * 0.4;
    let ambient_blur = max(height * 0.3, 2.0);
    let ambient_d = squircle_sdf(local - vec2<f32>(0.0, height * 0.08), half_size, radius);
    let ambient = (1.0 - smoothstep(-ambient_blur, ambient_blur, ambient_d)) * 0.5;
    let contact_blur = max(height * 0.04, 1.2);
    let contact_d = squircle_sdf(local - vec2<f32>(0.0, height * 0.02), half_size, radius);
    let contact = (1.0 - smoothstep(-contact_blur, contact_blur, contact_d)) * 0.6;
    let lift = halo + ambient * (1.0 - halo);
    let shade = clamp((lift + contact * (1.0 - lift)) * uniforms.shadow, 0.0, 1.0);

    // The card over its shadow, both straight alpha.
    let out_a = card.a + shade * (1.0 - card.a);
    if out_a <= 0.0001 {
        return vec4<f32>(0.0);
    }
    return vec4<f32>(card.rgb * card.a / out_a, out_a);
}
