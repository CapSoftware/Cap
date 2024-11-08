@group(0) @binding(0) var uyvy_input: texture_2d<u32>;

@group(0) @binding(1) var<storage, read_write> y_plane: array<u32>;
@group(0) @binding(2) var<storage, read_write> uv_plane: array<u32>;

@group(0) @binding(3) var<uniform> size: vec2<u32>;

@compute
@workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
	let coords = global_id.xy;

	// Each UYVY pixel contains 2 luma samples and shared UV samples
  let x = global_id.x / 4;
  let y = global_id.y / 4;

  let uyvy = textureLoad(uyvy_input, coords, 0).rgba;

  // Extract UYVY components
  let u = uyvy.r;
  let y1 = uyvy.g;
  let v = uyvy.b;
  let y2 = uyvy.a;

  // Write Y samples (one per actual pixel)
  let y_offset = y * size.x + (x * 2);
  y_plane[y_offset] = y1;
  y_plane[y_offset + 1] = y2;

  // this don't work :(

  // Handle UV downsampling
  // We only want to write UV values for every 2x2 block of pixels
  // This means we process UV on every other row
  if ((y % 2) == 0) {
      // Calculate the UV plane offset
      // UV plane is half the size in both dimensions
      let uv_row_stride = size.x; // Width of the UV plane in bytes
      let uv_offset = (y / 2) * uv_row_stride + x;

      // Write interleaved UV samples
      // Note: For every 2x2 block of pixels, we write one U and one V sample
      uv_plane[uv_offset] = u;     // U sample
      uv_plane[uv_offset + 1] = v; // V sample
  }
}
