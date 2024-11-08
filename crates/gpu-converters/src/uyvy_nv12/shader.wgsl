@group(0) @binding(0) var uyvy_input: texture_2d<u32>;

@group(0) @binding(1) var<storage, read_write> y_plane: array<u32>;
@group(0) @binding(2) var<storage, read_write> uv_plane: array<u32>;

@group(0) @binding(3) var<uniform> size: vec2<u32>;

@compute
@workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
	let coords = global_id.xy;

  let x = global_id.x / 2;
  let y = global_id.y / 4;

  let uyvy = textureLoad(uyvy_input, coords, 0).rgba;

  let u = uyvy.r;
  let y1 = uyvy.g;
  let v = uyvy.b;
  let y2 = uyvy.a;

  y_plane[y * size.x + x] = y1;
  y_plane[y * size.x + x + 1] = y2;

  // TODO: UV downsampling
}
