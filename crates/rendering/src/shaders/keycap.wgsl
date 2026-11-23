// Key presses drawn as physical keycaps. Every key on screen is drawn in one
// pass over the scissored overlay box, built up the way light falls on a real
// key: a wide ambient shadow and a tight contact shadow on the desk, the skirt
// darkening towards the desk, the top face with its gradient, dish, bevel and
// matte grain, and the press, which sinks the face into the skirt. A key in
// motion is drawn as a camera would catch it: averaged along its path over
// the shutter, so it smears the way it moves.

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
    // Dish depth (0..1), grain, gloss, and the key's own opacity.
    finish: vec4<f32>,
    // How far the key travels while the shutter is open, x and y in pixels,
    // centred on where it is drawn; then 1 for a sculpted cap whose walls
    // are lit as solid plastic, 0 for a laptop key; then unused.
    motion: vec4<f32>,
};

struct Uniforms {
    caps: array<Cap, 16>,
    // Key count, overall opacity, shadow strength, unused.
    info: vec4<f32>,
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

// The shadows a key casts on the desk: a soft halo all round it that lifts it
// off whatever lies behind, a wide ambient shadow below, then a tight contact
// shadow that closes in as the key is pressed.
fn desk_shadow(
    p: vec2<f32>,
    body_origin: vec2<f32>,
    body_size: vec2<f32>,
    height: f32,
    depth: f32,
    radius: f32,
    press: f32,
    shadow_strength: f32,
) -> vec4<f32> {
    var out = vec4<f32>(0.0);
    let halo_blur = max(height * HALO_REACH, 2.0);
    let halo_d = box_sdf(p, body_origin + vec2<f32>(0.0, height * 0.06), body_size, radius);
    let halo = (1.0 - smoothstep(-halo_blur * 0.3, halo_blur, halo_d)) * 0.34;
    out = over(out, paint(vec4<f32>(0.0, 0.0, 0.0, 1.0), halo * shadow_strength));
    let ambient_blur = max(height * 0.32, 2.0);
    let ambient_d = box_sdf(
        p,
        body_origin + vec2<f32>(0.0, depth * 1.6 + height * 0.05),
        body_size,
        radius,
    );
    let ambient = (1.0 - smoothstep(-ambient_blur, ambient_blur, ambient_d)) * 0.6;
    out = over(out, paint(vec4<f32>(0.0, 0.0, 0.0, 1.0), ambient * shadow_strength));
    let contact_blur = max(depth * (1.3 - press * 0.6), 1.2);
    let contact_d = box_sdf(p, body_origin + vec2<f32>(0.0, depth * 0.45), body_size, radius);
    let contact = 1.0 - smoothstep(-contact_blur, contact_blur, contact_d);
    return over(out, paint(vec4<f32>(0.0, 0.0, 0.0, 1.0), contact * shadow_strength));
}

// How far the halo reaches past a key, in key heights. The overlay's scissor
// (`KEYCAP_SHADOW_REACH` in `layers/keyboard.rs`) leaves room for it.
const HALO_REACH: f32 = 0.5;

// A mechanical keycap seen from in front and above, lit from above and a
// little to the left. Its top is a cylinder-dished face; around it the walls
// slope out to the plate: a deep front wall, narrow sides and a sliver of
// back wall. Each wall is shaded by the way it faces, falls into shade
// towards the plate, and meets the top in a rounded edge that catches the
// light along the back and left and turns from it along the front and right.
fn draw_sculpted(cap: Cap, p: vec2<f32>, shadow_strength: f32) -> vec4<f32> {
    let height = cap.rect.w;
    let radius = cap.shape.x;
    let depth = cap.shape.y;
    let inset = cap.shape.z;
    let press = cap.shape.w;
    let sink = depth * press;

    // The cap moves down into the switch: the walls shorten from the top
    // while their foot stays on the plate.
    let body_origin = vec2<f32>(cap.rect.x, cap.rect.y + sink);
    let body_size = vec2<f32>(cap.rect.z, cap.rect.w - sink);
    var out = desk_shadow(p, body_origin, body_size, height, depth, radius, press, shadow_strength);

    let face_origin = vec2<f32>(cap.rect.x + inset, cap.rect.y + sink + inset * 0.4);
    let face_size = vec2<f32>(cap.rect.z - inset * 2.0, cap.rect.w - depth - inset * 0.85);
    let face_radius = max(radius * 0.8, 1.0);
    let body_d = box_sdf(p, body_origin, body_size, radius);
    // Seen from in front, the top narrows towards the back, so the side
    // walls widen as they come forward.
    let centre = face_origin + face_size * 0.5;
    let towards_back = 1.0 - clamp((p.y - face_origin.y) / max(face_size.y, 1.0), 0.0, 1.0);
    // The same slope on every key, so a long key tapers like a short one.
    let half_width = max(face_size.x * 0.5, 1.0);
    let narrowing = 1.0 - min(height * 0.035 * towards_back / half_width, 0.2);
    let tapered = vec2<f32>(centre.x + (p.x - centre.x) / narrowing, p.y);
    let face_d = box_sdf(tapered, face_origin, face_size, face_radius);

    // Which way the surface under `p` faces, in the plane of the screen:
    // out from the nearest point of the face's straight edges.
    let core = max(face_size * 0.5 - vec2<f32>(face_radius), vec2<f32>(0.0));
    let q = tapered - centre;
    let outward = q - clamp(q, -core, core);
    let reach = length(outward);
    var facing = vec2<f32>(0.0, 1.0);
    if reach > 0.001 {
        facing = outward / reach;
    }
    // Light falls from above and the left: the back and left walls catch
    // it, the right turns from it, and the front faces the viewer, lit
    // only by what spills down over the top.
    let lit = 0.86 - 0.14 * facing.y - 0.07 * facing.x;

    // The walls: from the face's edge (0) to the plate (1).
    let across = clamp(face_d / max(face_d - body_d, 0.001), 0.0, 1.0);
    var wall = cap.side_a.rgb * lit;
    // The rounded top edge rolls into the wall: it holds the light just
    // below the face and the wall darkens on its way to the plate.
    wall = wall * mix(1.06, 0.84, smoothstep(0.0, 1.0, across));
    wall = mix(wall, cap.side_b.rgb * lit, smoothstep(0.55, 1.0, across) * 0.6);
    let roll = (1.0 - smoothstep(0.0, 0.22, across)) * max(-facing.y * 0.5 + 0.5, 0.25);
    wall = mix(wall, cap.top_a.rgb, roll * 0.28);
    wall = wall + vec3<f32>(grain(p) * cap.finish.y);
    out = over(out, paint(vec4<f32>(wall, 1.0), coverage(body_d)));

    // The face: its gradient, the dish, a soft sheen and the rounded rim.
    let fy = clamp((p.y - face_origin.y) / max(face_size.y, 1.0), 0.0, 1.0);
    let fx = clamp((p.x - face_origin.x) / max(face_size.x, 1.0), 0.0, 1.0) * 2.0 - 1.0;
    var face = mix(cap.top_a, cap.top_b, fy).rgb;
    // A cylinder dish curves across the key: its left side turns towards
    // the right, away from the light, and its right side towards it; the
    // middle sits a touch lower.
    let dish = cap.finish.x;
    face = face * (1.0 + dish * (0.05 * fx - 0.035 * (1.0 - fx * fx)));
    // A broad, soft sheen high on the face.
    let sheen_at = (p - (face_origin + face_size * vec2<f32>(0.35, 0.2))) / max(face_size, vec2<f32>(1.0));
    let sheen = exp(-dot(sheen_at, sheen_at) * 6.0) * cap.finish.z * 4.0;
    face = mix(face, vec3<f32>(1.0), clamp(sheen, 0.0, 0.3));
    // The rim rounds over into the walls, bright where it faces the light.
    let rim_width = max(height * 0.045, 1.5);
    let rim = 1.0 - smoothstep(0.0, rim_width, -face_d);
    let rim_light = -0.6 * facing.y - 0.3 * facing.x;
    face = face * (1.0 + rim * rim * rim_light * 0.16);
    face = face + vec3<f32>(grain(p) * cap.finish.y);
    out = over(out, paint(vec4<f32>(face, 1.0), coverage(face_d)));

    // A thin line of light where the back of the rim meets the top.
    let upper = 1.0 - smoothstep(0.0, face_size.y * 0.35, p.y - face_origin.y);
    let line = 1.0 - smoothstep(0.0, 1.2, -face_d);
    out = over(out, paint(cap.highlight, coverage(face_d) * line * upper * 0.7));

    // A fine edge around the foot of the cap.
    let border = coverage(body_d) * (1.0 - smoothstep(0.0, 1.1, -body_d));
    return over(out, paint(cap.border, border));
}

// One key at `p`, premultiplied, before its own opacity.
fn draw_cap(cap: Cap, p: vec2<f32>, shadow_strength: f32) -> vec4<f32> {
    if cap.motion.z > 0.5 {
        return draw_sculpted(cap, p, shadow_strength);
    }
    var out = vec4<f32>(0.0);
    let height = cap.rect.w;
    let radius = cap.shape.x;
    let depth = cap.shape.y;
    let inset = cap.shape.z;
    let press = cap.shape.w;
    let sink = depth * press;

    // The skirt shortens from the top as the key goes down.
    let body_origin = vec2<f32>(cap.rect.x, cap.rect.y + sink);
    let body_size = vec2<f32>(cap.rect.z, cap.rect.w - sink);

    out = desk_shadow(p, body_origin, body_size, height, depth, radius, press, shadow_strength);

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
    return out;
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let p = position.xy;
    let count = u32(uniforms.info.x);
    let shadow_strength = uniforms.info.z;
    var out = vec4<f32>(0.0);

    for (var i = 0u; i < 16u; i = i + 1u) {
        if i >= count {
            break;
        }
        let cap = uniforms.caps[i];
        let travel = cap.motion.xy;
        // Skip pixels this key and its shadow cannot reach.
        let reach = cap.rect.w * (HALO_REACH + 0.15) + cap.shape.y * 2.0 + abs(travel) * 0.5;
        if p.x < cap.rect.x - reach.x || p.x > cap.rect.x + cap.rect.z + reach.x
            || p.y < cap.rect.y - reach.y || p.y > cap.rect.y + cap.rect.w + reach.y {
            continue;
        }
        // Each key is built up on its own, then laid over the keys before it
        // at its own opacity, so keys fade in and out independently.
        var key = vec4<f32>(0.0);
        let distance = length(travel);
        if distance < 0.75 {
            key = draw_cap(cap, p, shadow_strength);
        } else {
            let samples = u32(clamp(ceil(distance / 1.5), 2.0, 16.0));
            for (var k = 0u; k < samples; k = k + 1u) {
                let along = f32(k) / f32(samples - 1u) - 0.5;
                key = key + draw_cap(cap, p - travel * along, shadow_strength);
            }
            key = key / f32(samples);
        }
        out = over(out, key * clamp(cap.finish.w, 0.0, 1.0));
    }

    let opacity = clamp(uniforms.info.y, 0.0, 1.0);
    let alpha = out.a * opacity;
    if alpha <= 0.0001 {
        return vec4<f32>(0.0);
    }
    return vec4<f32>(out.rgb / max(out.a, 0.0001), alpha);
}
