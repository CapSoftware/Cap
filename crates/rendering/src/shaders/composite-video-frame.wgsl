struct Uniforms {
		crop_bounds: vec4<f32>,
		target_bounds: vec4<f32>,
    output_size: vec2<f32>,
    frame_size: vec2<f32>,
    velocity_uv: vec2<f32>,
    target_size: vec2<f32>,
    rounding_px: f32,
    mirror_x: f32
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

		let blur_scale = 5.0;
		var blur_samples = 50;

		if u.velocity_uv.x == 0.0 && u.velocity_uv.y == 0.0 {
				blur_samples = 1;
		}

	  var color = vec4<f32>(0.0, 0.0, 0.0, 0.0);

		for (var i = 0; i < blur_samples; i++) {
		    let t = f32(i) / f32(blur_samples - 1);
		    let offset = u.velocity_uv * t * blur_scale;
		   	let sample_uv = target_uv - offset;
		   	var sample_color = sample_texture(sample_uv, crop_bounds_uv);
				sample_color = apply_rounded_corners(sample_color, sample_uv);

				color += sample_color;
		}

		let ret_color = color / f32(blur_samples);

		return mix(textureSample(prev_tex, sampler0, uv), ret_color.rgba, ret_color.a);
}

fn sample_texture(uv: vec2<f32>, crop_bounds_uv: vec4<f32>) -> vec4<f32> {
		if uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0 {
				var cropped_uv = (uv + crop_bounds_uv.xy) * (crop_bounds_uv.zw - crop_bounds_uv.xy);

				if u.mirror_x != 0.0 {
						cropped_uv.x = (1.0 - uv.x + crop_bounds_uv.x) * (crop_bounds_uv.z - crop_bounds_uv.x);
				}

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
