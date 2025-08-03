use std::mem;

#[repr(C)]
struct CaptionBackgroundUniforms {
    position: [f32; 2],      // 8 bytes
    size: [f32; 2],          // 8 bytes
    color: [f32; 4],         // 16 bytes
    corner_radius: f32,      // 4 bytes
    viewport_size: [f32; 2], // 8 bytes
    _padding: [f32; 3],      // 12 bytes
}

fn main() {
    println\!("Size of CaptionBackgroundUniforms: {}", mem::size_of::<CaptionBackgroundUniforms>());
    println\!("Offset of position: {}", mem::offset_of\!(CaptionBackgroundUniforms, position));
    println\!("Offset of size: {}", mem::offset_of\!(CaptionBackgroundUniforms, size));
    println\!("Offset of color: {}", mem::offset_of\!(CaptionBackgroundUniforms, color));
    println\!("Offset of corner_radius: {}", mem::offset_of\!(CaptionBackgroundUniforms, corner_radius));
    println\!("Offset of viewport_size: {}", mem::offset_of\!(CaptionBackgroundUniforms, viewport_size));
    println\!("Offset of _padding: {}", mem::offset_of\!(CaptionBackgroundUniforms, _padding));
}
