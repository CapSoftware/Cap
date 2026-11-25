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

@group(0) @binding(0) var frame: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> regions: array<Region>;
@group(0) @binding(2) var<storage, read_write> averages: array<vec4<f32>>;
@group(0) @binding(3) var<uniform> params: Params;
fn find_region(block: u32) -> u32 {
    var index = 0u;
    for (var i = 0u; i < params.region_count; i++) {
        if regions[i].offset <= block {
            index = i;
        }
    }
    return index;
}

@compute @workgroup_size(64)
fn average(@builtin(global_invocation_id) id: vec3<u32>) {
    let block = id.x;
    if block >= params.total_blocks {
        return;
    }
    let region = regions[find_region(block)];
    let local = block - region.offset;
    let bx = local % region.blocks_x;
    let by = local / region.blocks_x;
    let full = vec2<u32>(region.block);
    let limit = min(region.origin + region.size, params.frame_size);
    // A block cut short by the region's edge averages a full block ending at
    // that edge: a sliver a pixel or two wide averages to the source column
    // itself and shows it.
    let start = max(
        min(region.origin + vec2<u32>(bx, by) * region.block, max(limit, full) - full),
        region.origin,
    );
    let end = min(start + full, limit);
    let step = max(1u, region.block / 8u);
    var sum = vec4<f32>(0.0);
    var count = 0.0;
    for (var y = start.y; y < end.y; y += step) {
        for (var x = start.x; x < end.x; x += step) {
            sum += textureLoad(frame, vec2<i32>(i32(x), i32(y)), 0);
            count += 1.0;
        }
    }
    averages[block] = sum / max(count, 1.0);
}
