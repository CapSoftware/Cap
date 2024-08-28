struct Uniforms {
    fb_size: vec2<f32>,
    border_pc: f32,
    x_offset: f32,
    mirror: u32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var texture: texture_2d<f32>;
@group(0) @binding(2) var sample: sampler;

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

fn round_corners(color: vec4<f32>, clip_position: vec2<f32>, size: vec2<f32>) -> vec4<f32> {
	let smallest_axis = min(size.x, size.y);
	let border_radius = smallest_axis * min(max(uniforms.border_pc / 100.0, 0.0), 1.0);

	if (clip_position.x > size.x || clip_position.y > size.y) {
		return vec4<f32>(0.0);
	}

	let corner = size - border_radius;
	let relative_to_corner = abs((clip_position - (size / 2)) * 2);

	let distance = length(relative_to_corner - corner);

	if(relative_to_corner.x > corner.x && relative_to_corner.y > corner.y && distance > border_radius) {
		return vec4<f32>(0.0);
	}

	return color;
}

fn crop_texture(clip_position: vec2<f32>, origin: vec2<f32>, size: vec2<f32>) -> vec4<f32> {
		let divisor = (size + vec2<f32>(origin.x * 2, 0.0));
		var position = (clip_position.xy + origin) / divisor;

		if(uniforms.mirror == 1) {
				position.x = 1.0 - position.x;
		}

		return textureSample(
				texture,
				sample,
				position
		);
}

@fragment
fn fs_main(
    @location(0) tex_coords: vec2<f32>,
    @builtin(position) clip_position: vec4<f32>
) -> @location(0) vec4<f32> {
		let origin = vec2<f32>(uniforms.x_offset, 0.0);
		let size = uniforms.fb_size.xy;

		var final_color = crop_texture(clip_position.xy , origin, size);

		final_color = round_corners(final_color, clip_position.xy, size);

		return final_color;
}
