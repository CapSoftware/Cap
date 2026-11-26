struct Region {
    origin: vec2<u32>,
    size: vec2<u32>,
    block: u32,
    blocks_x: u32,
    blocks_y: u32,
    offset: u32,
    flags: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

struct Params {
    frame_size: vec2<u32>,
    region_count: u32,
    total_blocks: u32,
};

@group(0) @binding(0) var<storage, read> blocks: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> quads: array<Region>;
@group(0) @binding(2) var<uniform> quad_params: Params;

struct VertexOut {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(flat) region: u32,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
    let region = quads[instance];
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0),
    );
    let corner = corners[vertex];
    let pixel = vec2<f32>(region.origin) + corner * vec2<f32>(region.size);
    let size = vec2<f32>(quad_params.frame_size);
    let ndc = vec2<f32>(pixel.x / size.x * 2.0 - 1.0, 1.0 - pixel.y / size.y * 2.0);
    var out: VertexOut;
    out.position = vec4<f32>(ndc, 0.0, 1.0);
    out.region = instance;
    return out;
}

fn block_at(region: Region, x: i32, y: i32) -> vec4<f32> {
    let cx = u32(clamp(x, 0, i32(region.blocks_x) - 1));
    let cy = u32(clamp(y, 0, i32(region.blocks_y) - 1));
    return blocks[region.offset + cy * region.blocks_x + cx];
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    let region = quads[in.region];
    let local = in.position.xy - vec2<f32>(region.origin);
    let block = f32(region.block);
    var color: vec4<f32>;
    if (region.flags & 2u) != 0u {
        let cell = local / block - vec2<f32>(0.5);
        let base = floor(cell);
        let f = cell - base;
        let ix = i32(base.x);
        let iy = i32(base.y);
        let top = mix(block_at(region, ix, iy), block_at(region, ix + 1, iy), f.x);
        let bottom = mix(block_at(region, ix, iy + 1), block_at(region, ix + 1, iy + 1), f.x);
        color = mix(top, bottom, f.y);
    } else {
        let cell = vec2<i32>(floor(local / block));
        color = block_at(region, cell.x, cell.y);
    }
    if (region.flags & 1u) != 0u {
        let edge = min(min(local.x, local.y), min(f32(region.size.x) - local.x, f32(region.size.y) - local.y));
        let ring = max(2.0, f32(quad_params.frame_size.y) / 540.0);
        if edge < ring {
            color = vec4<f32>(mix(color.rgb, vec3<f32>(0.2, 0.55, 1.0), 0.85), 1.0);
        }
    }
    return color;
}
