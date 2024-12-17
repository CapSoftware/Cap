struct Uniforms {
		crop_bounds: vec4<f32>,
		target_bounds: vec4<f32>,
    output_size: vec2<f32>,
    frame_size: vec2<f32>,
    velocity_uv: vec2<f32>,
    target_size: vec2<f32>,
    rounding_px: f32,
    mirror_x: f32,
    motion_blur_amount: f32,
    camera_motion_blur_amount: f32,
    _padding: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var frame_tex: texture_2d<f32>;
@group(0) @binding(2) var prev_tex: texture_2d<f32>;
@group(0) @binding(3) var sampler0: sampler;

@fragment
fn fs_main(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {
    let base_color = textureSample(frame_tex, sampler0, frag_coord.xy / u.output_size);
    let color = main_image(base_color, frag_coord.xy);
    return vec4(color.rgb, 1.0);
}

fn main_image(frag_color: vec4<f32>, frag_coord: vec2<f32>) -> vec4<f32> {
		let uv = frag_coord / u.output_size;
		let target_uv = (frag_coord - u.target_bounds.xy) / u.target_size;
		let crop_bounds_uv = vec4<f32>(u.crop_bounds.xy / u.frame_size, u.crop_bounds.zw / u.frame_size);

		if target_uv.x < 0.0 || target_uv.x > 1.0 || target_uv.y < 0.0 || target_uv.y > 1.0 {
				return textureSample(prev_tex, sampler0, uv);
		}

		var base_color = sample_texture(target_uv, crop_bounds_uv);
		base_color = apply_rounded_corners(base_color, target_uv);

		let blur_amount = select(u.motion_blur_amount, u.camera_motion_blur_amount, u.camera_motion_blur_amount > 0.0);

		if blur_amount < 0.01 {
				return mix(textureSample(prev_tex, sampler0, uv), base_color, base_color.a);
		}

		let center = vec2<f32>(0.5, 0.5);
		let dir = normalize(target_uv - center);

		let base_samples = 16.0;
		let num_samples = i32(base_samples * smoothstep(0.0, 1.0, blur_amount));

		var accum = base_color;
		var weight_sum = 1.0;

		for (var i = 1; i < num_samples; i++) {
				let t = f32(i) / f32(num_samples);
				let dist_from_center = length(target_uv - center);

				let random_offset = (rand(target_uv + vec2<f32>(t)) - 0.5) * 0.1 * smoothstep(0.0, 0.2, blur_amount);

				let base_scale = select(
					0.08,  // Regular content scale
					0.16,  // Camera scale (reduced from 0.24 to 0.16)
					u.camera_motion_blur_amount > 0.0
				);
				let scale = dist_from_center * blur_amount * (base_scale + random_offset) * smoothstep(0.0, 0.1, blur_amount);

				let angle_variation = (rand(target_uv + vec2<f32>(t * 2.0)) - 0.5) * 0.1 * smoothstep(0.0, 0.2, blur_amount);
				let rotated_dir = vec2<f32>(
						dir.x * cos(angle_variation) - dir.y * sin(angle_variation),
						dir.x * sin(angle_variation) + dir.y * cos(angle_variation)
				);

				let offset = rotated_dir * scale * t;

				let sample_uv = target_uv - offset;
				if sample_uv.x >= 0.0 && sample_uv.x <= 1.0 && sample_uv.y >= 0.0 && sample_uv.y <= 1.0 {
						var sample_color = sample_texture(sample_uv, crop_bounds_uv);
						sample_color = apply_rounded_corners(sample_color, sample_uv);

						let weight = (1.0 - t) * (1.0 + random_offset * 0.2);
						accum += sample_color * weight;
						weight_sum += weight;
				}
		}

		let final_color = accum / weight_sum;

		let blurred = vec4(final_color.rgb, base_color.a);

		return mix(textureSample(prev_tex, sampler0, uv), blurred, blurred.a);
}

fn sample_texture(_uv: vec2<f32>, crop_bounds_uv: vec4<f32>) -> vec4<f32> {
		var uv = _uv;

		if uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0 {
				if u.mirror_x != 0.0 {
						uv.x = 1.0 - uv.x;
				}

				var cropped_uv = uv * (crop_bounds_uv.zw - crop_bounds_uv.xy) + crop_bounds_uv.xy;

				return textureSample(frame_tex, sampler0, cropped_uv);
		}

		return vec4(0.0);
}

fn apply_rounded_corners(current_color: vec4<f32>, target_uv: vec2<f32>) -> vec4<f32> {
		let target_coord = abs(target_uv * u.target_size - u.target_size / 2.0);
		let rounding_point = u.target_size / 2.0 - u.rounding_px;
		let target_rounding_coord = target_coord - rounding_point;

		let distance = abs(length(target_rounding_coord)) - u.rounding_px;

		let distance_blur = 1.0;

		if target_rounding_coord.x >= 0.0 && target_rounding_coord.y >= 0.0 && distance >= -distance_blur/2 {
			// distance_blur adds some antialiasing
			return mix(current_color, vec4<f32>(0.0), min(distance / distance_blur + 0.5, 1.0));
		}

		return current_color;
}

// Add this helper function for pseudo-random numbers
fn rand(co: vec2<f32>) -> f32 {
		return fract(sin(dot(co, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

// Add smoothstep helper function if not already present
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
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
