@group(0) @binding(0)
var uyvy_input: texture_2d<u32>;

@group(0) @binding(1)
var rgba_output: texture_storage_2d<rgba8unorm, write>;

@compute
@workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
		let coords = global_id.xy;

    let x = global_id.x;
    let y = global_id.y;

    let uyvy = textureLoad(uyvy_input, coords, 0).rgba;

    let u = f32(uyvy.r) / 255.0;
    let y1 = f32(uyvy.g) / 255.0;
    let v = f32(uyvy.b) / 255.0;
    let y2 = f32(uyvy.a) / 255.0;

    let r = clamp(y1 + 1.403 * (v - 0.5), 0.0, 1.0);
    let g = clamp(y1 - 0.344 * (u - 0.5) - 0.714 * (v - 0.5), 0.0, 1.0);
    let b = clamp(y1 + 1.770 * (u - 0.5), 0.0, 1.0);

    let output_coords = coords * vec2<u32>(2, 1);

    textureStore(rgba_output, output_coords, vec4<f32>(r, g, b, 1.0));

    let r2 = clamp(y2 + 1.403 * (v - 0.5), 0.0, 1.0);
    let g2 = clamp(y2 - 0.344 * (u - 0.5) - 0.714 * (v - 0.5), 0.0, 1.0);
    let b2 = clamp(y2 + 1.770 * (u - 0.5), 0.0, 1.0);

    textureStore(rgba_output, output_coords + vec2<u32>(1, 0), vec4<f32>(r2, g2, b2, 1.0));
}
