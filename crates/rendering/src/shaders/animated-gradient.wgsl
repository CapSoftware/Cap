struct GradientUniforms {
	stops: array<vec4<f32>, 5>,
	flow: vec4<f32>,
	lighting: vec4<f32>,
	texture: vec4<f32>,
	motion: vec4<f32>,
	output: vec4<f32>,
}

struct VertexOutput {
	@builtin(position) position: vec4<f32>,
	@location(0) uv: vec2<f32>,
}

struct HarmonicField {
	value: f32,
	gradient: vec2<f32>,
}

@group(0) @binding(0) var<uniform> u: GradientUniforms;
@group(0) @binding(1) var surface: texture_2d<f32>;
@group(0) @binding(2) var surface_sampler: sampler;

const TAU: f32 = 6.283185307179586;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
	var positions = array<vec2<f32>, 3>(
		vec2<f32>(-1.0, -1.0),
		vec2<f32>(3.0, -1.0),
		vec2<f32>(-1.0, 3.0),
	);
	let position = positions[vertex_index];
	var output: VertexOutput;
	output.position = vec4<f32>(position, 0.0, 1.0);
	output.uv = vec2<f32>((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5);
	return output;
}

fn harmonic_field(
	coordinate: vec2<f32>,
	time: f32,
	seed_offset: f32,
	detail: u32,
) -> HarmonicField {
	var value = 0.0;
	var gradient = vec2<f32>(0.0);
	var amplitude = 1.0;
	var frequency = 0.36;
	var weight = 0.0;
	for (var level = 0u; level < 6u; level = level + 1u) {
		if (level >= detail) {
			break;
		}
		let index = f32(level);
		let seed = u.motion.z * 0.7548777 + u.motion.w * 0.5698403 + seed_offset;
		let angle = TAU * fract(seed * 0.1732051 + index * 0.3819660);
		let direction = vec2<f32>(cos(angle), sin(angle));
		let wave_a = direction * frequency;
		let wave_b = vec2<f32>(-direction.y, direction.x) * frequency * 1.17;
		let phase_a = TAU * fract(seed * 0.6180340 + index * 0.4142136);
		let phase_b = TAU * fract(seed * 0.2718282 + index * 0.7320508 + 0.37);
		let theta_a = TAU * dot(coordinate, wave_a) + phase_a + time * (0.82 + index * 0.11);
		let theta_b = TAU * dot(coordinate, wave_b) + phase_b - time * (0.57 + index * 0.08);
		value += amplitude * (sin(theta_a) * 0.62 + cos(theta_b) * 0.38);
		gradient += amplitude * TAU * (
			cos(theta_a) * wave_a * 0.62 - sin(theta_b) * wave_b * 0.38
		);
		weight += amplitude;
		amplitude *= 0.52;
		frequency *= 1.86;
	}
	return HarmonicField(value / weight, gradient / weight);
}

fn palette(position: f32) -> vec3<f32> {
	let count = u32(clamp(round(u.output.z), 2.0, 5.0));
	let first = u.stops[0];
	if (position <= first.w) {
		return first.rgb;
	}
	var previous = first;
	for (var index = 1u; index < 5u; index = index + 1u) {
		if (index >= count) {
			break;
		}
		let current = u.stops[index];
		if (position <= current.w) {
			let interval = max(current.w - previous.w, 0.00001);
			let progress = clamp((position - previous.w) / interval, 0.0, 1.0);
			return mix(previous.rgb, current.rgb, progress);
		}
		previous = current;
	}
	return previous.rgb;
}

fn edge_aligned_uv(uv: vec2<f32>) -> vec2<f32> {
	let pixel_step = vec2<f32>(abs(dpdx(uv.x)), abs(dpdy(uv.y)));
	let span = max(vec2<f32>(1.0) - pixel_step, vec2<f32>(0.00001));
	return clamp((uv - pixel_step * 0.5) / span, vec2<f32>(0.0), vec2<f32>(1.0));
}

@fragment
fn fs_surface(input: VertexOutput) -> @location(0) vec4<f32> {
	let uv = edge_aligned_uv(input.uv);
	let direction = vec2<f32>(cos(u.flow.x), sin(u.flow.x));
	let perpendicular = vec2<f32>(-direction.y, direction.x);
	let projection_span = max(abs(direction.x) + abs(direction.y), 0.00001);
	let base_position = dot(uv - vec2<f32>(0.5), direction) / projection_span + 0.5;
	let aspect = max(u.output.x, 1.0) / max(u.output.y, 1.0);
	let canvas = vec2<f32>((uv.x - 0.5) * aspect, uv.y - 0.5);
	let scale = max(u.flow.y, 0.2);
	let coordinate = vec2<f32>(dot(canvas, direction), dot(canvas, perpendicular)) * scale;
	let detail = u32(clamp(round(u.output.w), 1.0, 6.0));
	let guide = harmonic_field(coordinate, u.motion.x, 0.137, detail);
	let bend = vec2<f32>(
		guide.value * 0.58 - guide.gradient.y * 0.10,
		-guide.value * 0.31 + guide.gradient.x * 0.10,
	);
	let curved_coordinate = coordinate + bend * u.flow.w;
	let flowing = harmonic_field(
		curved_coordinate + vec2<f32>(2.73, -1.91),
		u.motion.x * 0.79,
		0.713,
		detail,
	);
	let displacement = guide.value * 0.57 + flowing.value * 0.43;
	let gradient_position = clamp(base_position + displacement * u.flow.z * 0.30, 0.0, 1.0);
	var color = palette(gradient_position);

	let ripple_size = max(u.lighting.w, 0.05);
	let ripple_phase = TAU * (
		(flowing.value * 0.56 + guide.value * 0.22) / ripple_size +
		dot(coordinate, vec2<f32>(0.08, -0.05))
	);
	let ripple_enabled = select(0.0, 1.0, u.lighting.w > 0.0);
	let base_slope = flowing.gradient * 0.64 + guide.gradient * 0.36;
	let ripple_slope = cos(ripple_phase) * TAU / ripple_size * (
		flowing.gradient * 0.56 + guide.gradient * 0.22 + vec2<f32>(0.08, -0.05)
	);
	let slope = base_slope + ripple_slope * ripple_enabled * 0.18;
	let relief = u.lighting.x;
	let normal = normalize(vec3<f32>(-slope * relief * 0.42, 1.0));
	let light_direction = normalize(vec3<f32>(-0.48, -0.62, 0.86));
	let illumination = dot(normal, light_direction);
	let highlight = pow(max(illumination, 0.0), 4.0) * u.lighting.y * relief * 0.32;
	let shadow = (1.0 - smoothstep(0.12, 0.82, illumination)) * u.lighting.z * relief * 0.28;
	color = color * (1.0 - shadow) + vec3<f32>(highlight);
	return vec4<f32>(color, 1.0);
}

fn hash_u32(input: u32) -> u32 {
	var value = input;
	value = (value ^ (value >> 16u)) * 0x7feb352du;
	value = (value ^ (value >> 15u)) * 0x846ca68bu;
	return value ^ (value >> 16u);
}

fn grain_value(uv: vec2<f32>) -> f32 {
	let grain_size = max(u.texture.y, 0.5);
	let pixel = vec2<u32>(floor(uv * max(u.output.xy, vec2<f32>(1.0)) / grain_size));
	let seed_low = u32(round(max(u.motion.z, 0.0) * 1024.0));
	let seed_high = u32(round(max(u.motion.w, 0.0) * 1024.0));
	let seed = seed_low | (seed_high << 16u);
	let time_cell = u32(max(floor(abs(u.motion.x) * 24.0), 0.0));
	let hash = hash_u32(
		pixel.x * 0x9e3779b9u ^ pixel.y * 0x85ebca6bu ^ seed ^ time_cell * 0xc2b2ae35u,
	);
	return f32(hash & 0x00ffffffu) / 16777215.0;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
	var color = textureSample(surface, surface_sampler, input.uv).rgb;
	color *= exp2(u.texture.z);
	color = (color - vec3<f32>(0.5)) * u.texture.w + vec3<f32>(0.5);
	let luminance = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
	let neutral = vec3<f32>(luminance);
	if (u.motion.y <= 1.0) {
		color = mix(neutral, color, u.motion.y);
	} else {
		let saturation = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
		let vibrance = 1.0 + (u.motion.y - 1.0) * (1.0 - clamp(saturation, 0.0, 1.0));
		color = neutral + (color - neutral) * vibrance;
	}
	let grain = (grain_value(input.uv) - 0.5) * u.texture.x * 0.18;
	color += vec3<f32>(grain);
	return vec4<f32>(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
