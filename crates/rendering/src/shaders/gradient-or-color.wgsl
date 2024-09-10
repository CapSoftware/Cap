struct Uniforms {
	start: vec4<f32>,
	end: vec4<f32>,
	angle: f32
};

@group(0) @binding(0) var<uniform> u: Uniforms;

@fragment
fn fs_main(@location(0) tex_coords: vec2<f32>) -> @location(0) vec4<f32> {
    return gradient(tex_coords);
}

fn gradient(uv: vec2<f32>) -> vec4<f32> {
	  let angle_rad = u.angle * 3.14159 / 180.0;
	  let rotated_uv = vec2<f32>(
	      cos(angle_rad) * uv.x - sin(angle_rad) * uv.y,
	      sin(angle_rad) * uv.x + cos(angle_rad) * uv.y
	  );

	  let gradient_color = mix(
	   		vec4<f32>(u.start.rgb, 1.0),
				vec4<f32>(u.end.rgb, 1.0),
	   		rotated_uv.x
	  );

	  return vec4<f32>(gradient_color.rgb, gradient_color.a);
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
