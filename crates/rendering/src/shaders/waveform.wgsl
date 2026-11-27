struct WaveformUniforms {
    rect: vec4<f32>,
    canvas: vec4<f32>,
    color: vec4<f32>,
    secondary: vec4<f32>,
    shape: vec4<f32>,
    values: array<vec4<f32>, 64>,
};

@group(0) @binding(0) var<uniform> uniforms: WaveformUniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) local: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
    let corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(1.0, 1.0),
    );
    let pixel = uniforms.rect.xy + corners[index] * (uniforms.rect.zw + vec2<f32>(2.0));
    var out: VertexOutput;
    out.position = vec4<f32>(
        pixel.x / uniforms.canvas.x * 2.0 - 1.0,
        1.0 - pixel.y / uniforms.canvas.y * 2.0,
        0.0,
        1.0,
    );
    out.local = pixel - (uniforms.rect.xy - uniforms.rect.zw);
    return out;
}

fn bar_count() -> i32 {
    return i32(uniforms.canvas.z + 0.5);
}

fn amplitude(index: i32) -> f32 {
    let clamped = clamp(index, 0, bar_count() - 1);
    return uniforms.values[clamped / 4][clamped % 4];
}

fn rounded_box(p: vec2<f32>, half_size: vec2<f32>, radius: f32) -> f32 {
    let q = abs(p) - half_size + vec2<f32>(radius);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}

fn line_height(index: i32, size: vec2<f32>, reach: f32) -> f32 {
    let clamped = clamp(index, 0, bar_count() - 1);
    let direction = select(-1.0, 1.0, clamped % 2 == 0);
    return size.y * 0.5 - direction * amplitude(clamped) * reach;
}

fn line_distance(p: vec2<f32>, size: vec2<f32>, slot: f32, thickness: f32) -> f32 {
    let reach = max(size.y * 0.5 - thickness, 0.0);
    let u = clamp(p.x / slot - 0.5, 0.0, f32(bar_count() - 1));
    let segment = min(i32(floor(u)), bar_count() - 2);
    let t = u - f32(segment);
    let y0 = line_height(segment - 1, size, reach);
    let y1 = line_height(segment, size, reach);
    let y2 = line_height(segment + 1, size, reach);
    let y3 = line_height(segment + 2, size, reach);
    let a = -y0 + 3.0 * y1 - 3.0 * y2 + y3;
    let b = 2.0 * y0 - 5.0 * y1 + 4.0 * y2 - y3;
    let c = -y0 + y2;
    let y = 0.5 * (2.0 * y1 + c * t + b * t * t + a * t * t * t);
    let slope = 0.5 * (c + 2.0 * b * t + 3.0 * a * t * t) / slot;
    return abs(p.y - y) / sqrt(1.0 + slope * slope) - thickness;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let size = uniforms.rect.zw * 2.0;
    let count = bar_count();
    let style = i32(uniforms.canvas.w + 0.5);
    let slot = size.x / f32(count);
    let half_width = max(slot * uniforms.shape.x * 0.5, 0.5);
    let p = in.local;
    let index = clamp(i32(floor(p.x / slot)), 0, count - 1);
    let center_x = (f32(index) + 0.5) * slot;
    let level = amplitude(index);

    var distance: f32;
    if style == 2 {
        distance = line_distance(p, size, slot, max(half_width * 0.5, 1.0));
    } else if style == 3 {
        let rows = floor(level * max(size.y * 0.5 - half_width, 0.0) / slot);
        let row = clamp(round((p.y - size.y * 0.5) / slot), -rows, rows);
        distance = length(p - vec2<f32>(center_x, size.y * 0.5 + row * slot)) - half_width;
    } else {
        let height = max(level * size.y, half_width * 2.0);
        let center_y = select(size.y - height * 0.5, size.y * 0.5, style == 1);
        distance = rounded_box(
            p - vec2<f32>(center_x, center_y),
            vec2<f32>(half_width, height * 0.5),
            half_width * uniforms.shape.y,
        );
    }

    let coverage = clamp(0.5 - distance, 0.0, 1.0);
    let gradient = clamp(p.y / size.y, 0.0, 1.0) * uniforms.secondary.w;
    let color = mix(uniforms.color.rgb, uniforms.secondary.rgb, gradient);
    let alpha = coverage * uniforms.color.a;
    return vec4<f32>(color * alpha, alpha);
}
