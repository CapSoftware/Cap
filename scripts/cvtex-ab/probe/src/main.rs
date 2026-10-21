use std::cell::Cell;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

use block::ConcreteBlock;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_video::metal_texture::{CVMetalTexture, CVMetalTextureGetTexture};
use core_video::metal_texture_cache::CVMetalTextureCache;
use core_video::pixel_buffer::{
    CVPixelBuffer, CVPixelBufferKeys, kCVPixelFormatType_32BGRA,
    kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
};
use foreign_types::ForeignTypeRef;
use metal::{MTLOrigin, MTLPixelFormat, MTLSize, TextureDescriptor};

unsafe extern "C" {
    fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut u64) -> i32;
    fn getpid() -> i32;
}

fn footprint_mb() -> f64 {
    let mut info = [0u64; 64];
    if unsafe { proc_pid_rusage(getpid(), 4, info.as_mut_ptr()) } != 0 {
        return -1.0;
    }
    info[9] as f64 / 1048576.0
}

fn attrs() -> CFDictionary<CFString, CFType> {
    let empty = CFDictionary::<CFString, CFType>::from_CFType_pairs(&[]);
    CFDictionary::from_CFType_pairs(&[
        (
            CFString::from(CVPixelBufferKeys::IOSurfaceProperties),
            empty.as_CFType(),
        ),
        (
            CFString::from(CVPixelBufferKeys::MetalCompatibility),
            CFBoolean::true_value().as_CFType(),
        ),
    ])
}

fn new_buffer(nv12: bool, width: usize, height: usize) -> CVPixelBuffer {
    let format = if nv12 {
        kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    } else {
        kCVPixelFormatType_32BGRA
    };
    CVPixelBuffer::new(format, width, height, Some(&attrs())).expect("pixel buffer")
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args[1].as_str();
    let format = args[2].as_str();
    let flush = args[3] == "flush";
    let frames: usize = args[4].parse().unwrap();
    let paced = args.get(5).is_some_and(|value| value == "paced");
    let nv12 = format == "nv12";
    let (base_width, base_height) = if nv12 { (3456, 2234) } else { (1920, 1080) };

    let device = metal::Device::system_default().expect("metal device");
    let queue = device.new_command_queue();
    let cache = CVMetalTextureCache::new(None, device.clone(), None).expect("texture cache");
    let descriptor = TextureDescriptor::new();
    descriptor.set_width(64);
    descriptor.set_height(64);
    descriptor.set_pixel_format(MTLPixelFormat::BGRA8Unorm);
    let target = device.new_texture(&descriptor);
    descriptor.set_pixel_format(MTLPixelFormat::R8Unorm);
    let target_r8 = device.new_texture(&descriptor);

    let mut ring: Vec<CVPixelBuffer> = Vec::new();
    let mut ring_size = (0, 0);
    let mut inflight = VecDeque::new();
    let start = Instant::now();
    let label = format!(
        "mode={mode} format={format} flush={flush} paced={paced}",
    );
    println!("{label} frame=0 footprint_mb={:.1} device_mb={:.1}", footprint_mb(), device.current_allocated_size() as f64 / 1048576.0);

    for frame in 1..=frames {
        let (width, height) = match mode {
            "resize" => {
                let step = (frame / 30) % 40;
                (base_width - step * 16, base_height - step * 10)
            }
            _ => (base_width, base_height),
        };
        let buffer = match mode {
            "fresh" => new_buffer(nv12, width, height),
            _ => {
                if ring_size != (width, height) {
                    ring = (0..4).map(|_| new_buffer(nv12, width, height)).collect();
                    ring_size = (width, height);
                }
                ring[frame % ring.len()].clone()
            }
        };

        let command_buffer = queue.new_command_buffer().to_owned();
        let blit = command_buffer.new_blit_command_encoder();
        let mut retained: Vec<CVMetalTexture> = Vec::new();
        let planes: &[(MTLPixelFormat, usize)] = if nv12 {
            &[(MTLPixelFormat::R8Unorm, 0), (MTLPixelFormat::RG8Unorm, 1)]
        } else {
            &[(MTLPixelFormat::BGRA8Unorm, 0)]
        };
        for &(pixel_format, plane) in planes {
            let (plane_width, plane_height) = if nv12 {
                (buffer.get_width_of_plane(plane), buffer.get_height_of_plane(plane))
            } else {
                (buffer.get_width(), buffer.get_height())
            };
            let texture = cache
                .create_texture_from_image(
                    buffer.as_concrete_TypeRef(),
                    None,
                    pixel_format,
                    plane_width,
                    plane_height,
                    plane,
                )
                .expect("cv metal texture");
            let raw = unsafe { CVMetalTextureGetTexture(texture.as_concrete_TypeRef()) };
            let source = unsafe { metal::TextureRef::from_ptr(raw as *mut _) };
            if pixel_format == MTLPixelFormat::BGRA8Unorm || pixel_format == MTLPixelFormat::R8Unorm {
                let destination = if pixel_format == MTLPixelFormat::BGRA8Unorm { &target } else { &target_r8 };
                blit.copy_from_texture(
                    source,
                    0,
                    0,
                    MTLOrigin { x: 0, y: 0, z: 0 },
                    MTLSize { width: 64, height: 64, depth: 1 },
                    destination,
                    0,
                    0,
                    MTLOrigin { x: 0, y: 0, z: 0 },
                );
            }
            retained.push(texture);
        }
        blit.end_encoding();
        let resources = Cell::new(Some(retained));
        let block = ConcreteBlock::new(move |_: &metal::CommandBufferRef| {
            drop(resources.take());
        })
        .copy();
        command_buffer.add_completed_handler(&block);
        command_buffer.commit();
        drop(buffer);
        if flush {
            cache.flush(0);
        }
        inflight.push_back(command_buffer);
        while inflight.len() > 2 {
            inflight.pop_front().unwrap().wait_until_completed();
        }
        if paced {
            std::thread::sleep(Duration::from_millis(16));
        }
        if frame % 500 == 0 {
            println!(
                "{label} frame={frame} secs={:.1} footprint_mb={:.1} device_mb={:.1}",
                start.elapsed().as_secs_f64(),
                footprint_mb(),
                device.current_allocated_size() as f64 / 1048576.0,
            );
        }
    }
    while let Some(command_buffer) = inflight.pop_front() {
        command_buffer.wait_until_completed();
    }
    drop(ring);
    std::thread::sleep(Duration::from_millis(1500));
    println!(
        "{label} done secs={:.1} footprint_mb={:.1} device_mb={:.1}",
        start.elapsed().as_secs_f64(),
        footprint_mb(),
        device.current_allocated_size() as f64 / 1048576.0,
    );
    cache.flush(0);
    std::thread::sleep(Duration::from_millis(500));
    println!(
        "{label} after_final_flush footprint_mb={:.1} device_mb={:.1}",
        footprint_mb(),
        device.current_allocated_size() as f64 / 1048576.0,
    );
}
