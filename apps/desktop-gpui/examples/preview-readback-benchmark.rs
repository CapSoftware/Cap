//! Windows/Linux editor preview readback, old against new, on the device the
//! editor uses (`cap_rendering::create_shared_device`).
//!
//! "old" reproduces the shipped `EditorFrameFormat::Rgba` path exactly: the
//! padded RGBA readback is copied into a fresh `Vec` on the renderer thread
//! (`PendingReadback::wait`), then `editor_window::frame_image` un-pads and
//! swizzles it into a second fresh `Vec` for the `RenderImage`.
//!
//! "new" is `EditorFrameFormat::Bgra`: `RgbaToBgraReadback` blits to BGRA on
//! the GPU, `PendingBgraReadback::wait` makes the one tight copy out of the
//! mapped buffer, and `editor_window::bgra_frame_image` moves it into the
//! `RenderImage`. Its renderer-side number includes the `spawn_blocking`
//! submission poll the production wait does, so it is a slight overestimate.
//!
//! gpui's own atlas upload is identical on both paths and is not measured.
//!
//! Run: cargo run --manifest-path apps/desktop-gpui/Cargo.toml --example preview-readback-benchmark

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use gpui::RenderImage;
use smallvec::smallvec;

const WARMUP: usize = 10;
const ITERATIONS: usize = 120;
const LARGE_ALLOCATION: usize = 64 * 1024;

struct CountingAllocator;

static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
static LARGE_ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
static ALLOCATED_BYTES: AtomicU64 = AtomicU64::new(0);

fn count(size: usize) {
    ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
    ALLOCATED_BYTES.fetch_add(size as u64, Ordering::Relaxed);
    if size >= LARGE_ALLOCATION {
        LARGE_ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
    }
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count(new_size);
        unsafe { System.realloc(ptr, layout, new_size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: CountingAllocator = CountingAllocator;

#[derive(Clone, Copy)]
struct Allocations {
    all: u64,
    large: u64,
    bytes: u64,
}

fn allocations() -> Allocations {
    Allocations {
        all: ALLOCATIONS.load(Ordering::Relaxed),
        large: LARGE_ALLOCATIONS.load(Ordering::Relaxed),
        bytes: ALLOCATED_BYTES.load(Ordering::Relaxed),
    }
}

#[derive(Default)]
struct Samples {
    renderer_us: Vec<f64>,
    convert_us: Vec<f64>,
    cpu_us: Vec<f64>,
    total_ms: Vec<f64>,
    allocations: Vec<u64>,
    large_allocations: Vec<u64>,
    allocated_bytes: Vec<u64>,
}

struct Sample {
    renderer_us: f64,
    convert_us: f64,
    total_ms: f64,
    allocations: u64,
    large_allocations: u64,
    allocated_bytes: u64,
}

impl Samples {
    fn push(&mut self, sample: Sample) {
        self.renderer_us.push(sample.renderer_us);
        self.convert_us.push(sample.convert_us);
        self.cpu_us.push(sample.renderer_us + sample.convert_us);
        self.total_ms.push(sample.total_ms);
        self.allocations.push(sample.allocations);
        self.large_allocations.push(sample.large_allocations);
        self.allocated_bytes.push(sample.allocated_bytes);
    }
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[sorted.len() / 2]
}

fn p95(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[((sorted.len() - 1) as f64 * 0.95).round() as usize]
}

fn median_u64(values: &[u64]) -> u64 {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    sorted[sorted.len() / 2]
}

fn padded_bytes_per_row(width: u32) -> u32 {
    (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT
}

fn source_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    width: u32,
    height: u32,
) -> wgpu::Texture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Benchmark Source"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
    for y in 0..height {
        for x in 0..width {
            pixels.extend_from_slice(&[x as u8, y as u8, (x ^ y) as u8, 255]);
        }
    }
    queue.write_texture(
        texture.as_image_copy(),
        &pixels,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 4),
            rows_per_image: Some(height),
        },
        texture.size(),
    );
    texture
}

fn image_from(width: u32, height: u32, pixels: Vec<u8>) -> Arc<RenderImage> {
    let buffer = image::RgbaImage::from_raw(width, height, pixels).expect("tight frame");
    Arc::new(RenderImage::new(smallvec![image::Frame::new(buffer)]))
}

fn old_frame(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    buffer: &wgpu::Buffer,
) -> (Sample, Arc<RenderImage>) {
    let (width, height) = (texture.width(), texture.height());
    let stride = padded_bytes_per_row(width);
    let started = Instant::now();
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: Some(height),
            },
        },
        texture.size(),
    );
    queue.submit([encoder.finish()]);
    buffer.slice(..).map_async(wgpu::MapMode::Read, |result| {
        result.expect("RGBA readback maps")
    });
    device
        .poll(wgpu::PollType::Wait)
        .expect("RGBA readback completes");

    let before = allocations();
    let renderer_started = Instant::now();
    let mapped = buffer.slice(..).get_mapped_range();
    let mut data = Vec::with_capacity(mapped.len() + 24);
    data.extend_from_slice(&mapped);
    drop(mapped);
    buffer.unmap();
    let renderer_us = renderer_started.elapsed().as_secs_f64() * 1e6;

    let convert_started = Instant::now();
    let tight = cap_gpui_kernels::frame::unpad_rgba_to_bgra(
        &data,
        width as usize,
        stride as usize,
        height as usize,
    )
    .expect("RGBA frame un-pads");
    drop(data);
    let image = image_from(width, height, tight);
    let convert_us = convert_started.elapsed().as_secs_f64() * 1e6;
    let after = allocations();

    (
        Sample {
            renderer_us,
            convert_us,
            total_ms: started.elapsed().as_secs_f64() * 1e3,
            allocations: after.all - before.all,
            large_allocations: after.large - before.large,
            allocated_bytes: after.bytes - before.bytes,
        },
        image,
    )
}

fn new_frame(
    runtime: &tokio::runtime::Runtime,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    readback: &mut cap_rendering::RgbaToBgraReadback,
) -> (Sample, Arc<RenderImage>) {
    let started = Instant::now();
    let encoder = device.create_command_encoder(&Default::default());
    let pending = readback
        .submit(device, queue, encoder, texture, 0, 60)
        .expect("BGRA readback submits");
    device
        .poll(wgpu::PollType::Wait)
        .expect("BGRA readback completes");

    let before = allocations();
    let renderer_started = Instant::now();
    let frame = runtime
        .block_on(pending.wait(device))
        .expect("BGRA readback maps");
    let renderer_us = renderer_started.elapsed().as_secs_f64() * 1e6;

    let convert_started = Instant::now();
    let (width, height) = (frame.width, frame.height);
    let pixels = Arc::try_unwrap(frame.data).expect("renderer frame is unshared");
    let image = image_from(width, height, pixels);
    let convert_us = convert_started.elapsed().as_secs_f64() * 1e6;
    let after = allocations();

    (
        Sample {
            renderer_us,
            convert_us,
            total_ms: started.elapsed().as_secs_f64() * 1e3,
            allocations: after.all - before.all,
            large_allocations: after.large - before.large,
            allocated_bytes: after.bytes - before.bytes,
        },
        image,
    )
}

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime");
    let shared = runtime
        .block_on(cap_rendering::create_shared_device())
        .expect("wgpu device");
    let info = shared.adapter.get_info();
    println!(
        "adapter: {} | backend {:?} | type {:?} | driver {} {} | software={}",
        info.name,
        info.backend,
        info.device_type,
        info.driver,
        info.driver_info,
        shared.is_software_adapter
    );
    println!();
    println!(
        "| size | path | renderer copy µs p50 | pump convert µs p50 | CPU µs p50 | CPU µs p95 | submit to image ms p50 | allocs/frame | allocs >=64KiB/frame | MB allocated/frame | MB copied/frame |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|---|");

    let (device, queue) = (&shared.device, &shared.queue);
    for (label, width, height) in [
        ("Half 1248x702", 1248, 702),
        ("1080p", 1920, 1080),
        ("4K", 3840, 2160),
    ] {
        let texture = source_texture(device, queue, width, height);
        let stride = padded_bytes_per_row(width);
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Benchmark RGBA Readback"),
            size: u64::from(stride) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut readback = cap_rendering::RgbaToBgraReadback::new(device);

        let (_, old_image) = old_frame(device, queue, &texture, &buffer);
        let (_, new_image) = new_frame(&runtime, device, queue, &texture, &mut readback);
        assert_eq!(old_image.as_bytes(0), new_image.as_bytes(0), "{label}");

        for _ in 0..WARMUP {
            old_frame(device, queue, &texture, &buffer);
            new_frame(&runtime, device, queue, &texture, &mut readback);
        }
        let mut old = Samples::default();
        let mut new = Samples::default();
        for iteration in 0..ITERATIONS {
            if iteration % 2 == 0 {
                old.push(old_frame(device, queue, &texture, &buffer).0);
                new.push(new_frame(&runtime, device, queue, &texture, &mut readback).0);
            } else {
                new.push(new_frame(&runtime, device, queue, &texture, &mut readback).0);
                old.push(old_frame(device, queue, &texture, &buffer).0);
            }
        }

        let tight_bytes = width as f64 * height as f64 * 4.0;
        let padded_bytes = stride as f64 * height as f64;
        for (path, samples, copied) in [
            (
                "main (RGBA + CPU swizzle)",
                &old,
                padded_bytes + tight_bytes,
            ),
            ("branch (GPU BGRA, one copy)", &new, tight_bytes),
        ] {
            println!(
                "| {label} | {path} | {:.0} | {:.0} | {:.0} | {:.0} | {:.2} | {} | {} | {:.2} | {:.2} |",
                median(&samples.renderer_us),
                median(&samples.convert_us),
                median(&samples.cpu_us),
                p95(&samples.cpu_us),
                median(&samples.total_ms),
                median_u64(&samples.allocations),
                median_u64(&samples.large_allocations),
                median_u64(&samples.allocated_bytes) as f64 / 1e6,
                copied / 1e6,
            );
        }
    }
}
