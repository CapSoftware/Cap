const CAP_RADIUS: f32 = 8.0;
const CAP_TOP: f32 = 2.0;
const CAP_BOTTOM: f32 = 65.0;
const SHELF_TOP: f32 = 8.0;
const SHELF_BOTTOM: f32 = 71.0;
const SIDE_INSET: f32 = 2.0;
const SHADOW_OFFSET: f32 = 2.0;
const SHADOW_BLUR: f32 = 2.5;
const SHADOW_OPACITY: f32 = 0.75;
const BLEED: f32 = 10.0;
const KEY_HEIGHT: f32 = 74.0;

struct Key {
    rect: vec4<f32>,
    under_edge: vec4<f32>,
    under_center: vec4<f32>,
    cap_top: vec4<f32>,
    cap_bottom: vec4<f32>,
    stroke: vec4<f32>,
};

struct Keycaps {
    viewport: vec4<f32>,
    keys: array<Key, 12>,
};

@group(0) @binding(0) var<uniform> keycaps: Keycaps;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(flat) key_index: u32,
};

@vertex
fn vs_main(
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32,
) -> VertexOutput {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0),
    );

    let key = keycaps.keys[instance_index];
    let scale = key.rect.w;
    let bleed = BLEED * scale;
    let origin = key.rect.xy - vec2<f32>(bleed);
    let extent = vec2<f32>(key.rect.z, KEY_HEIGHT * scale) + vec2<f32>(bleed * 2.0);
    let pixel = origin + corners[vertex_index] * extent;
    let ndc = vec2<f32>(
        pixel.x / keycaps.viewport.x * 2.0 - 1.0,
        1.0 - pixel.y / keycaps.viewport.y * 2.0,
    );

    var output: VertexOutput;
    output.position = vec4<f32>(ndc, 0.0, 1.0);
    output.key_index = instance_index;
    return output;
}

fn rounded_box(p: vec2<f32>, center: vec2<f32>, half_size: vec2<f32>, radius: f32) -> f32 {
    let q = abs(p - center) - (half_size - vec2<f32>(radius));
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

fn coverage(distance: f32, pixel: f32) -> f32 {
    return clamp(0.5 - distance / pixel, 0.0, 1.0);
}

fn over(top: vec4<f32>, bottom: vec4<f32>) -> vec4<f32> {
    return top + bottom * (1.0 - top.a);
}

fn layer(fill: vec3<f32>, stroke: vec3<f32>, distance: f32, pixel: f32) -> vec4<f32> {
    let outer = coverage(distance - 0.5, pixel);
    let inner = coverage(distance + 0.5, pixel);
    let color = mix(stroke, fill, inner);
    return vec4<f32>(color * outer, outer);
}

@fragment
fn fs_main(
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(flat) key_index: u32,
) -> @location(0) vec4<f32> {
    let key = keycaps.keys[key_index];
    let scale = key.rect.w;
    let pixel = 1.0 / scale;
    let width = key.rect.z / scale;
    let p = (position.xy - key.rect.xy) / scale;

    let half_width = (width - SIDE_INSET * 2.0) * 0.5;
    let center_x = width * 0.5;
    let cap_half = vec2<f32>(half_width, (CAP_BOTTOM - CAP_TOP) * 0.5);
    let cap_center = vec2<f32>(center_x, (CAP_TOP + CAP_BOTTOM) * 0.5);
    let shelf_half = vec2<f32>(half_width, (SHELF_BOTTOM - SHELF_TOP) * 0.5);
    let shelf_center = vec2<f32>(center_x, (SHELF_TOP + SHELF_BOTTOM) * 0.5);

    let shadow_distance = rounded_box(
        p - vec2<f32>(0.0, SHADOW_OFFSET),
        shelf_center,
        shelf_half,
        CAP_RADIUS,
    );
    let shadow_alpha = SHADOW_OPACITY * (1.0 - smoothstep(-SHADOW_BLUR, SHADOW_BLUR, shadow_distance));
    var color = vec4<f32>(0.0, 0.0, 0.0, shadow_alpha);

    let shelf_t = abs((p.x - SIDE_INSET) / (width - SIDE_INSET * 2.0) * 2.0 - 1.0);
    let shelf_fill = mix(key.under_center.rgb, key.under_edge.rgb, clamp(shelf_t, 0.0, 1.0));
    let shelf_distance = rounded_box(p, shelf_center, shelf_half, CAP_RADIUS);
    color = over(layer(shelf_fill, key.stroke.rgb, shelf_distance, pixel), color);

    let cap_t = clamp((p.y - CAP_TOP) / (CAP_BOTTOM - CAP_TOP), 0.0, 1.0);
    let cap_fill = mix(key.cap_top.rgb, key.cap_bottom.rgb, cap_t);
    let cap_distance = rounded_box(p, cap_center, cap_half, CAP_RADIUS);
    color = over(layer(cap_fill, key.stroke.rgb, cap_distance, pixel), color);

    if color.a <= 0.0 {
        return vec4<f32>(0.0);
    }

    let opacity = key.stroke.a;
    return vec4<f32>(color.rgb / color.a, color.a * opacity);
}
