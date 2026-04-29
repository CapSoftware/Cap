struct Uniforms {
	start: vec4<f32>,
	end: vec4<f32>,
	angle: f32,
	noise_intensity: f32,
	noise_scale: f32,
	_padding: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

fn hash22(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn value_noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u_interp = f * f * (3.0 - 2.0 * f);

    return mix(
        mix(hash22(i + vec2(0.0, 0.0)), hash22(i + vec2(1.0, 0.0)), u_interp.x),
        mix(hash22(i + vec2(0.0, 1.0)), hash22(i + vec2(1.0, 1.0)), u_interp.x),
        u_interp.y
    );
}

fn fbm(p: vec2<f32>) -> f32 {
    var value = 0.0;
    var amplitude = 0.5;
    var coord = p;
    for (var i = 0; i < 4; i++) {
        value += amplitude * value_noise(coord);
        coord *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

fn overlay_channel(base: f32, blend: f32) -> f32 {
    if base < 0.5 {
        return 2.0 * base * blend;
    } else {
        return 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
    }
}

@fragment
fn fs_main(@location(0) tex_coords: vec2<f32>) -> @location(0) vec4<f32> {
    var color = gradient(tex_coords);

    if u.noise_intensity > 0.0 {
        let freq = 0.3 + ((100.0 - u.noise_scale) / 100.0) * 1.2;
        let n = fbm(tex_coords * freq * 600.0);

        let blended = vec3<f32>(
            overlay_channel(color.r, n),
            overlay_channel(color.g, n),
            overlay_channel(color.b, n),
        );

        let intensity = (u.noise_intensity / 100.0) * 0.25;
        color = vec4<f32>(mix(color.rgb, blended, intensity), color.a);
    }

    return color;
}

fn gradient(uv: vec2<f32>) -> vec4<f32> {
		let angle_rad = radians(u.angle + 270.0);

		let dir = vec2<f32>(cos(angle_rad), sin(angle_rad));

		let proj = dot(uv - 0.5, dir) + 0.5;

		let t = clamp(proj, 0.0, 1.0);

		return mix(u.start, u.end, t);
}

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(i32(in_vertex_index & 1u) * 4 - 1);
    let y = f32(i32(in_vertex_index & 2u) * 2 - 1);
    out.tex_coords = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
    out.clip_position = vec4<f32>(x, y, 0.0, 1.0);

    return out;
}
