// Key presses drawn as physical keycaps. Every key on screen is drawn in one
// pass over the scissored overlay box, built up the way light falls on a real
// key: a wide ambient shadow and a tight contact shadow on the desk, the skirt
// darkening towards the desk, the top face with its gradient, dish, bevel and
// matte grain, and the press, which sinks the face into the skirt.

struct Cap {
    // The key at rest, skirt included: x, y, width, height in pixels.
    rect: vec4<f32>,
    top_a: vec4<f32>,
    top_b: vec4<f32>,
    side_a: vec4<f32>,
    side_b: vec4<f32>,
    border: vec4<f32>,
    highlight: vec4<f32>,
    // Corner radius, skirt depth, face inset (all pixels), and how far the key
    // is pressed in (0..1).
    shape: vec4<f32>,
    // Dish depth (0..1), grain, gloss, unused.
    finish: vec4<f32>,
};

struct Uniforms {
    caps: array<Cap, 16>,
    // Key count, overall opacity, shadow strength, unused.
    info: vec4<f32>,
    // The keyboard deck the keys sit in: rect, top and bottom colours, and
    // corner radius, whether it is drawn, and how far it reaches past the
    // keys.
    plate: vec4<f32>,
    plate_top: vec4<f32>,
    plate_bottom: vec4<f32>,
    plate_shape: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

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
    let r = min(radius, min(half_size.x, half_size.y));
    let q = abs(p) - (half_size - vec2<f32>(r));
    if q.x <= 0.0 && q.y <= 0.0 {
        return max(q.x, q.y) - r;
    }
    let corner = max(q, vec2<f32>(0.0));
    let n = 4.0;
    return pow(pow(corner.x, n) + pow(corner.y, n), 1.0 / n) - r;
}

fn box_sdf(p: vec2<f32>, origin: vec2<f32>, size: vec2<f32>, radius: f32) -> f32 {
    return squircle_sdf(p - (origin + size * 0.5), size * 0.5, radius);
}

fn coverage(distance: f32) -> f32 {
    return 1.0 - smoothstep(-0.75, 0.75, distance);
}

// `layer` over `under`, both premultiplied.
fn over(under: vec4<f32>, layer: vec4<f32>) -> vec4<f32> {
    return layer + under * (1.0 - layer.a);
}

fn paint(color: vec4<f32>, amount: f32) -> vec4<f32> {
    let a = color.a * clamp(amount, 0.0, 1.0);
    return vec4<f32>(color.rgb * a, a);
}

// Stable per-pixel noise for the plastic's matte texture.
fn grain(p: vec2<f32>) -> f32 {
    let q = floor(p);
    return fract(sin(dot(q, vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5;
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let p = position.xy;
    let count = u32(uniforms.info.x);
    let shadow_strength = uniforms.info.z;
    var out = vec4<f32>(0.0);

    if uniforms.plate_shape.y > 0.5 {
        let origin = uniforms.plate.xy;
        let size = uniforms.plate.zw;
        let radius = uniforms.plate_shape.x;
        let reach = uniforms.plate_shape.z;
        // The deck lifts off the frame on a soft shadow.
        let blur = max(reach * 1.4, 2.0);
        let shadow_d = box_sdf(p, origin + vec2<f32>(0.0, reach * 0.5), size, radius);
        let shadow = (1.0 - smoothstep(-blur, blur, shadow_d)) * shadow_strength * 0.8;
        out = over(out, paint(vec4<f32>(0.0, 0.0, 0.0, 1.0), shadow));
        let d = box_sdf(p, origin, size, radius);
        let t = clamp((p.y - origin.y) / max(size.y, 1.0), 0.0, 1.0);
        var deck = mix(uniforms.plate_top.rgb, uniforms.plate_bottom.rgb, t);
        // The well is shaded under its top lip and lit along its lower rim.
        let inside = -d;
        let lip = (1.0 - smoothstep(0.0, reach * 0.9, p.y - origin.y)) * 0.35;
        deck = deck * (1.0 - lip);
        let rim = (1.0 - smoothstep(0.0, 1.5, inside))
            * smoothstep(origin.y + size.y * 0.5, origin.y + size.y, p.y);
        deck = mix(deck, vec3<f32>(1.0), rim * 0.12);
        deck = deck + vec3<f32>(grain(p) * 0.006);
        out = over(out, paint(vec4<f32>(deck, 1.0), coverage(d)));
    }

    for (var i = 0u; i < 16u; i = i + 1u) {
        if i >= count {
            break;
        }
        let cap = uniforms.caps[i];
        let height = cap.rect.w;
        let radius = cap.shape.x;
        let depth = cap.shape.y;
        let inset = cap.shape.z;
        let press = cap.shape.w;
        let sink = depth * press;

        // The skirt shortens from the top as the key goes down.
        let body_origin = vec2<f32>(cap.rect.x, cap.rect.y + sink);
        let body_size = vec2<f32>(cap.rect.z, cap.rect.w - sink);

        // A wide, faint ambient shadow, then a tight contact shadow that
        // closes in as the key is pressed.
        let ambient_blur = max(height * 0.3, 2.0);
        let ambient_d = box_sdf(
            p,
            body_origin + vec2<f32>(0.0, depth * 1.6 + height * 0.04),
            body_size,
            radius,
        );
        let ambient = (1.0 - smoothstep(-ambient_blur, ambient_blur, ambient_d)) * 0.5;
        out = over(out, paint(vec4<f32>(0.0, 0.0, 0.0, 1.0), ambient * shadow_strength));
        let contact_blur = max(depth * (1.3 - press * 0.6), 1.2);
        let contact_d = box_sdf(p, body_origin + vec2<f32>(0.0, depth * 0.45), body_size, radius);
        let contact = 1.0 - smoothstep(-contact_blur, contact_blur, contact_d);
        out = over(out, paint(vec4<f32>(0.0, 0.0, 0.0, 1.0), contact * shadow_strength));

        // The face, inset from the skirt and above it.
        let face_origin = vec2<f32>(cap.rect.x + inset, cap.rect.y + sink + inset * 0.4);
        let face_size = vec2<f32>(cap.rect.z - inset * 2.0, cap.rect.w - depth - inset * 0.85);
        let face_bottom = face_origin.y + face_size.y;

        // The skirt: lit where it meets the face, falling into shade towards
        // the desk.
        let body_d = box_sdf(p, body_origin, body_size, radius);
        let skirt_t = smoothstep(face_bottom - depth * 0.4, body_origin.y + body_size.y, p.y);
        var skirt = mix(cap.side_a, cap.side_b, skirt_t);
        // A sculpted key's sides catch light from above.
        let side_lit = 1.0 - smoothstep(0.0, max(inset, 1.0), p.y - body_origin.y);
        skirt = vec4<f32>(mix(skirt.rgb, cap.top_b.rgb, side_lit * 0.35), skirt.a);
        out = over(out, paint(skirt, coverage(body_d)));

        let face_radius = max(radius - inset * 0.55, radius * 0.6);
        let face_d = box_sdf(p, face_origin, face_size, face_radius);
        let fy = clamp((p.y - face_origin.y) / max(face_size.y, 1.0), 0.0, 1.0);
        let fx = clamp((p.x - face_origin.x) / max(face_size.x, 1.0), 0.0, 1.0) * 2.0 - 1.0;
        var face = mix(cap.top_a, cap.top_b, fy).rgb;

        // A dished top is darker in its middle and lit along its rims.
        let dish = cap.finish.x;
        face = face * (1.0 - dish * 0.07 * (1.0 - fx * fx) * (1.0 - (fy * 2.0 - 1.0) * (fy * 2.0 - 1.0) * 0.5));

        // Satin sheen across the top of the face.
        let gloss = cap.finish.z * (1.0 - smoothstep(0.0, 0.5, fy));
        face = mix(face, vec3<f32>(1.0), gloss);

        // The bevel: the face's lower rim turns away from the light, its
        // side rims a touch less so.
        let rim_depth = -face_d;
        let lower_rim = smoothstep(face_bottom - height * 0.1, face_bottom, p.y)
            * (1.0 - smoothstep(0.0, height * 0.08, rim_depth));
        face = mix(face, cap.side_a.rgb, lower_rim * 0.45);
        let side_rim = 1.0 - smoothstep(0.0, height * 0.05, rim_depth);
        face = face * (1.0 - side_rim * 0.05);

        // Matte grain in the plastic.
        face = face + vec3<f32>(grain(p) * cap.finish.y);

        out = over(out, paint(vec4<f32>(face, 1.0), coverage(face_d)));

        // The lit top edge: a bright line just inside the face's upper rim,
        // fading into a soft glow.
        let upper = 1.0 - smoothstep(0.0, face_size.y * 0.5, p.y - face_origin.y);
        let line = 1.0 - smoothstep(0.0, 1.4, rim_depth);
        let glow = (1.0 - smoothstep(0.0, height * 0.08, rim_depth)) * 0.35;
        out = over(out, paint(cap.highlight, coverage(face_d) * max(line, glow) * upper));

        // A fine border around the whole key.
        let border = coverage(body_d) * (1.0 - smoothstep(0.0, 1.1, -body_d));
        out = over(out, paint(cap.border, border));
    }

    let opacity = clamp(uniforms.info.y, 0.0, 1.0);
    let alpha = out.a * opacity;
    if alpha <= 0.0001 {
        return vec4<f32>(0.0);
    }
    return vec4<f32>(out.rgb / max(out.a, 0.0001), alpha);
}
