struct Globals {
    output_size: vec4<f32>,
};

@group(0) @binding(0) var<uniform> globals: Globals;

struct Instance {
    @location(0) quad: vec4<f32>,
    @location(1) geometry: vec4<f32>,
    @location(2) head: vec4<f32>,
    @location(3) tail: vec4<f32>,
    @location(4) dir: vec4<f32>,
    @location(5) stroke: vec4<f32>,
    @location(6) fill: vec4<f32>,
    @location(7) params: vec4<f32>,
    @location(8) shadow: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(flat) geometry: vec4<f32>,
    @location(1) @interpolate(flat) head: vec4<f32>,
    @location(2) @interpolate(flat) tail: vec4<f32>,
    @location(3) @interpolate(flat) dir: vec4<f32>,
    @location(4) @interpolate(flat) stroke: vec4<f32>,
    @location(5) @interpolate(flat) fill: vec4<f32>,
    @location(6) @interpolate(flat) params: vec4<f32>,
    @location(7) @interpolate(flat) shadow: vec4<f32>,
};

const PI: f32 = 3.14159265;
const FAR: f32 = 1.0e6;

@vertex
fn vs_main(@builtin(vertex_index) index: u32, instance: Instance) -> VertexOutput {
    let corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0),
    );
    let pixel = mix(instance.quad.xy, instance.quad.zw, corners[index]);
    let size = max(globals.output_size.xy, vec2<f32>(1.0));
    var out: VertexOutput;
    out.position = vec4<f32>(
        pixel.x / size.x * 2.0 - 1.0,
        1.0 - pixel.y / size.y * 2.0,
        0.0,
        1.0,
    );
    out.geometry = instance.geometry;
    out.head = instance.head;
    out.tail = instance.tail;
    out.dir = instance.dir;
    out.stroke = instance.stroke;
    out.fill = instance.fill;
    out.params = instance.params;
    out.shadow = instance.shadow;
    return out;
}

fn sd_segment(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
    let pa = p - a;
    let ba = b - a;
    let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1.0e-8), 0.0, 1.0);
    return length(pa - ba * h);
}

fn sd_triangle(p: vec2<f32>, p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>) -> f32 {
    let e0 = p1 - p0;
    let e1 = p2 - p1;
    let e2 = p0 - p2;
    let v0 = p - p0;
    let v1 = p - p1;
    let v2 = p - p2;
    let pq0 = v0 - e0 * clamp(dot(v0, e0) / max(dot(e0, e0), 1.0e-8), 0.0, 1.0);
    let pq1 = v1 - e1 * clamp(dot(v1, e1) / max(dot(e1, e1), 1.0e-8), 0.0, 1.0);
    let pq2 = v2 - e2 * clamp(dot(v2, e2) / max(dot(e2, e2), 1.0e-8), 0.0, 1.0);
    let s = sign(e0.x * e2.y - e0.y * e2.x);
    let d = min(
        min(
            vec2<f32>(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
            vec2<f32>(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x)),
        ),
        vec2<f32>(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)),
    );
    return -sqrt(d.x) * sign(d.y);
}

fn sd_round_rect(p: vec2<f32>, half_size: vec2<f32>, radius: f32) -> f32 {
    let q = abs(p) - half_size + vec2<f32>(radius);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

// Closest point on the ellipse by a few fixed-point iterations, which stay
// exact for circles where the analytic quartic divides by zero.
fn sd_ellipse(p: vec2<f32>, ab: vec2<f32>) -> f32 {
    let r = max(ab, vec2<f32>(1.0e-3));
    let pa = abs(p);
    var t = vec2<f32>(0.70710678, 0.70710678);
    for (var i = 0; i < 4; i = i + 1) {
        let xy = r * t;
        let e = vec2<f32>(
            (r.x * r.x - r.y * r.y) * t.x * t.x * t.x / r.x,
            (r.y * r.y - r.x * r.x) * t.y * t.y * t.y / r.y,
        );
        let rv = xy - e;
        let qv = pa - e;
        let rl = length(rv);
        let ql = max(length(qv), 1.0e-6);
        t = clamp((qv * rl / ql + e) / r, vec2<f32>(0.0), vec2<f32>(1.0));
        t = t / max(length(t), 1.0e-6);
    }
    let distance = length(pa - r * t);
    let normalized = pa / r;
    return select(distance, -distance, dot(normalized, normalized) < 1.0);
}

fn arc_angle(v: vec2<f32>, from_dir: vec2<f32>) -> f32 {
    let to_dir = vec2<f32>(-from_dir.y, from_dir.x);
    return atan2(dot(v, to_dir), dot(v, from_dir));
}

// Arc length along a rounded rect's outline from the end of the top-left
// corner, clockwise, for the point of the outline nearest `p`.
fn round_rect_param(p: vec2<f32>, h: vec2<f32>, r: f32) -> f32 {
    let inner = h - vec2<f32>(r);
    let top = 2.0 * inner.x;
    let side = 2.0 * inner.y;
    let arc = 0.5 * PI * r;
    let q = abs(p) - inner;
    if (q.x > 0.0 && q.y > 0.0) {
        let c = vec2<f32>(sign(p.x) * inner.x, sign(p.y) * inner.y);
        let v = p - c;
        if (p.x > 0.0 && p.y < 0.0) {
            return top + clamp(arc_angle(v, vec2<f32>(0.0, -1.0)), 0.0, 0.5 * PI) * r;
        }
        if (p.x > 0.0) {
            return top + arc + side + clamp(arc_angle(v, vec2<f32>(1.0, 0.0)), 0.0, 0.5 * PI) * r;
        }
        if (p.y > 0.0) {
            return 2.0 * top + 2.0 * arc + side
                + clamp(arc_angle(v, vec2<f32>(0.0, 1.0)), 0.0, 0.5 * PI) * r;
        }
        return 2.0 * top + 3.0 * arc + 2.0 * side
            + clamp(arc_angle(v, vec2<f32>(-1.0, 0.0)), 0.0, 0.5 * PI) * r;
    }
    if (q.y >= q.x) {
        if (p.y < 0.0) {
            return clamp(p.x + inner.x, 0.0, top);
        }
        return top + 2.0 * arc + side + clamp(inner.x - p.x, 0.0, top);
    }
    if (p.x > 0.0) {
        return top + arc + clamp(p.y + inner.y, 0.0, side);
    }
    return 2.0 * top + 3.0 * arc + side + clamp(inner.y - p.y, 0.0, side);
}

fn ellipse_perimeter(ab: vec2<f32>) -> f32 {
    let a = ab.x;
    let b = ab.y;
    return PI * (3.0 * (a + b) - sqrt((3.0 * a + b) * (a + 3.0 * b)));
}

// Signed distance from a filled arrow head whose corners are rounded by
// `radius` without growing past the unrounded triangle.
fn sd_head(p: vec2<f32>, head: vec4<f32>, dir: vec2<f32>, radius: f32) -> f32 {
    let tip = head.xy;
    let length_px = head.z;
    let width = head.w;
    if (length_px < 0.01 || width < 0.01) {
        return FAR;
    }
    let base = tip - dir * length_px;
    let perp = vec2<f32>(-dir.y, dir.x);
    let p1 = base + perp * width * 0.5;
    let p2 = base - perp * width * 0.5;
    let side_a = width;
    let side_b = length(tip - p2);
    let side_c = length(tip - p1);
    let perimeter = side_a + side_b + side_c;
    let incenter = (side_a * tip + side_b * p1 + side_c * p2) / perimeter;
    let inradius = length_px * width / perimeter;
    let rounding = min(radius, inradius * 0.6);
    let k = (inradius - rounding) / inradius;
    return sd_triangle(
        p,
        incenter + (tip - incenter) * k,
        incenter + (p1 - incenter) * k,
        incenter + (p2 - incenter) * k,
    ) - rounding;
}

fn sd_chevron(p: vec2<f32>, head: vec4<f32>, dir: vec2<f32>, half_stroke: f32) -> f32 {
    let tip = head.xy;
    if (head.z < 0.01) {
        return FAR;
    }
    let base = tip - dir * head.z;
    let perp = vec2<f32>(-dir.y, dir.x);
    let arm = min(
        sd_segment(p, tip, base + perp * head.w * 0.5),
        sd_segment(p, tip, base - perp * head.w * 0.5),
    );
    return arm - half_stroke;
}

// x: distance to the stroke, y: distance to the fill.
fn shape_distance(p: vec2<f32>, in: VertexOutput) -> vec2<f32> {
    let kind = in.params.x;
    let stroke_width = in.params.y;
    let half_stroke = stroke_width * 0.5;
    if (kind < 0.5) {
        var stroke = FAR;
        if (stroke_width > 0.0) {
            stroke = sd_segment(p, in.geometry.xy, in.geometry.zw) - half_stroke;
        }
        let style = in.dir.z;
        let dir = in.dir.xy;
        if (style > 1.5 && style < 2.5) {
            stroke = min(stroke, sd_chevron(p, in.head, dir, half_stroke));
        } else if (style > 0.5) {
            stroke = min(stroke, sd_head(p, in.head, dir, in.dir.w));
            stroke = min(stroke, sd_head(p, in.tail, -dir, in.dir.w));
        }
        return vec2<f32>(stroke, FAR);
    }

    let center = in.geometry.xy;
    let half_size = in.geometry.zw;
    let local = p - center;
    let draw = in.params.w;
    var d: f32;
    var trim = -FAR;
    if (kind < 1.5) {
        let radius = in.params.z;
        d = sd_round_rect(local, half_size, radius);
        if (draw < 1.0) {
            let inner = half_size - vec2<f32>(radius);
            let perimeter = 4.0 * (inner.x + inner.y) + 2.0 * PI * radius;
            trim = round_rect_param(local, half_size, radius) - draw * perimeter;
        }
    } else {
        d = sd_ellipse(local, half_size);
        if (draw < 1.0) {
            let n = local / max(half_size, vec2<f32>(1.0e-3));
            let turn = fract((atan2(n.y, n.x) + 0.5 * PI) / (2.0 * PI));
            trim = (turn - draw) * ellipse_perimeter(half_size);
        }
    }
    var stroke = FAR;
    if (stroke_width > 0.0) {
        stroke = max(abs(d) - half_stroke, trim);
    }
    return vec2<f32>(stroke, d);
}

fn coverage(distance: f32) -> f32 {
    return clamp(0.5 - distance, 0.0, 1.0);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let p = in.position.xy;
    let distance = shape_distance(p, in);
    let stroke_cover = coverage(distance.x) * in.stroke.a;
    let fill_cover = coverage(distance.y);
    let shape = vec4<f32>(in.stroke.rgb * stroke_cover, stroke_cover)
        + in.fill * fill_cover * (1.0 - stroke_cover);

    let shadow_alpha = in.shadow.z;
    if (shadow_alpha <= 0.0) {
        return shape;
    }
    let blur = max(in.shadow.y, 0.5);
    let shifted = shape_distance(p - vec2<f32>(in.shadow.x, in.shadow.w), in);
    let shadow_stroke = (1.0 - smoothstep(-blur, blur, distance_or_far(shifted.x))) * in.stroke.a;
    let shadow_fill = (1.0 - smoothstep(-blur, blur, distance_or_far(shifted.y))) * in.fill.a;
    let shadow = max(shadow_stroke, shadow_fill) * shadow_alpha;
    return shape + vec4<f32>(0.0, 0.0, 0.0, shadow) * (1.0 - shape.a);
}

fn distance_or_far(distance: f32) -> f32 {
    return select(distance, FAR, distance >= FAR * 0.5);
}
