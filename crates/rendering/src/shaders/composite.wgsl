struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var screen_texture: texture_2d<f32>;
@group(0) @binding(2) var screen_sampler: sampler;
@group(0) @binding(3) var webcam_texture: texture_2d<f32>;
@group(0) @binding(4) var webcam_sampler: sampler;

struct Uniforms {
	screen_bounds: vec4<f32>,
	webcam_bounds: vec4<f32>,
	background_start: vec4<f32>,
	background_end: vec4<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(i32(in_vertex_index & 1u) * 4 - 1);
    let y = f32(i32(in_vertex_index & 2u) * 2 - 1);
    out.tex_coords = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
    out.clip_position = vec4<f32>(x, y, 0.0, 1.0);

    return out;
}

fn gradient(uv: vec2<f32>) -> vec4<f32> {
    let angle_rad = 0.0 /*uniforms.background_angle*/ * 3.14159 / 180.0;
    let rotated_uv = vec2<f32>(
        cos(angle_rad) * uv.x - sin(angle_rad) * uv.y,
        sin(angle_rad) * uv.x + cos(angle_rad) * uv.y
    );

    let gradient_color = mix(
    		vec4<f32>(uniforms.background_start.rgb * (25.0 / 33.0), 1),
     		vec4<f32>(uniforms.background_end.rgb * (25.0 / 33.0), 1),
       	rotated_uv.x
    );
    return vec4<f32>(gradient_color.rgb, gradient_color.a);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
		var final_color = gradient(in.tex_coords);

		let relative_to_screen = (in.tex_coords - uniforms.screen_bounds.xy) / uniforms.screen_bounds.zw;

		if (relative_to_screen.x >= 0 && relative_to_screen.y >= 0 && relative_to_screen.x <= 1 && relative_to_screen.y <= 1) {
			let screen_color = textureSample(screen_texture, screen_sampler, relative_to_screen);
			final_color = mix(final_color, screen_color, screen_color.a);
		}

		let relative_to_webcam = (in.tex_coords - uniforms.webcam_bounds.xy) / uniforms.webcam_bounds.zw;

		if (relative_to_webcam.x >= 0 && relative_to_webcam.y >= 0 && relative_to_webcam.x <= 1 && relative_to_webcam.y <= 1) {
			let webcam_color = textureSample(webcam_texture, webcam_sampler, relative_to_webcam);
			final_color = mix(final_color, webcam_color, webcam_color.a);
		}

		return final_color;
}
