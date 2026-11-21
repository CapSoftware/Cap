//! The path blur kernel (`motion_blur_kernel = 1`): equal taps over the whole
//! frame-to-frame path for pans and zooms, and a shadow that trails with the
//! card.

use cap_rendering::composite_frame::{CompositeVideoFramePipeline, CompositeVideoFrameUniforms};

struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: CompositeVideoFramePipeline,
}

fn gpu() -> Option<Gpu> {
    let instance = cap_rendering::create_wgpu_instance_sync();
    let Ok(adapter) =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
    else {
        eprintln!("no GPU adapter available, skipping motion blur path tests");
        return None;
    };
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .expect("create motion blur test device");
    let pipeline = CompositeVideoFramePipeline::new(&device);
    Some(Gpu {
        device,
        queue,
        pipeline,
    })
}

const WIDTH: u32 = 400;
const HEIGHT: u32 = 40;
/// Px either side of the black/white edge that the edge measurements read.
const EDGE_WINDOW: u32 = 80;

/// Black on the left half, white on the right.
fn edge_source() -> Vec<u8> {
    let mut rgba = Vec::with_capacity((WIDTH * HEIGHT * 4) as usize);
    for _ in 0..HEIGHT {
        for x in 0..WIDTH {
            let v = if x < WIDTH / 2 { 0 } else { 255 };
            rgba.extend_from_slice(&[v, v, v, 255]);
        }
    }
    rgba
}

fn render(gpu: &Gpu, uniforms: CompositeVideoFrameUniforms, output: [u32; 2]) -> Vec<u8> {
    let Gpu {
        device,
        queue,
        pipeline,
    } = gpu;
    let frame = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &frame,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &edge_source(),
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(WIDTH * 4),
            rows_per_image: Some(HEIGHT),
        },
        frame.size(),
    );
    let [width, height] = output;
    let frame_view = frame.create_view(&Default::default());
    let uniforms_buffer = uniforms.to_buffer(device);
    let bind_group = pipeline.bind_group(device, &uniforms_buffer, &frame_view);
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let padded_row = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
        * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: (padded_row * height) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let view = target.create_view(&Default::default());
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        pass.set_pipeline(&pipeline.render_pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &target,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded_row),
                rows_per_image: Some(height),
            },
        },
        target.size(),
    );
    queue.submit([encoder.finish()]);
    readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    device
        .poll(wgpu::PollType::Wait)
        .expect("wait for motion blur readback");
    let mapped = readback.slice(..).get_mapped_range();
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for row in 0..height {
        let start = (row * padded_row) as usize;
        pixels.extend_from_slice(&mapped[start..start + (width * 4) as usize]);
    }
    pixels
}

fn card(kernel: f32) -> CompositeVideoFrameUniforms {
    CompositeVideoFrameUniforms {
        output_size: [WIDTH as f32, HEIGHT as f32],
        frame_size: [WIDTH as f32, HEIGHT as f32],
        crop_bounds: [0.0, 0.0, WIDTH as f32, HEIGHT as f32],
        target_bounds: [0.0, 0.0, WIDTH as f32, HEIGHT as f32],
        target_size: [WIDTH as f32, HEIGHT as f32],
        rounding_px: 0.0,
        corner_radii: [0.0; 4],
        motion_blur_kernel: kernel,
        ..Default::default()
    }
}

/// How far the black-to-white edge's brightness centroid sits from where the
/// sharp edge is, in px, averaged over the middle row band. Positive is to
/// the left (towards where the content came from).
fn edge_shift_px(pixels: &[u8]) -> f64 {
    let mut total = 0.0;
    let rows = (HEIGHT / 4)..(HEIGHT * 3 / 4);
    let count = rows.len() as f64;
    for y in rows {
        // Brightness integrated across the edge: a sharp edge leaves the left
        // side black, so every unit of light spilled left is a px of shift.
        // The window stays clear of the card's own sides, which the blur
        // fades too.
        let spill: f64 = (WIDTH / 2 - EDGE_WINDOW..WIDTH / 2)
            .map(|x| pixels[((y * WIDTH + x) * 4) as usize] as f64 / 255.0)
            .sum();
        let missing: f64 = (WIDTH / 2..WIDTH / 2 + EDGE_WINDOW)
            .map(|x| 1.0 - pixels[((y * WIDTH + x) * 4) as usize] as f64 / 255.0)
            .sum();
        total += spill - missing;
    }
    total / count
}

/// Furthest px left of the edge that still picks up light.
fn edge_reach_px(pixels: &[u8]) -> u32 {
    let y = HEIGHT / 2;
    (0..WIDTH / 2)
        .find(|&x| pixels[((y * WIDTH + x) * 4) as usize] > 6)
        .map_or(0, |x| WIDTH / 2 - x)
}

#[test]
fn pan_path_kernel_spreads_the_whole_frame_step() {
    let Some(gpu) = gpu() else { return };
    // A 40 px step to the right: content under a pixel came from 40 px to
    // its right. The streak covers the whole step evenly, so the edge's
    // light centroid moves half the step.
    let step = 40.0;
    let pan = |kernel| CompositeVideoFrameUniforms {
        motion_blur_vector: [step / WIDTH as f32, 0.0],
        motion_blur_params: [1.0, 1.0, 0.0, 0.0],
        ..card(kernel)
    };
    let path = render(&gpu, pan(1.0), [WIDTH, HEIGHT]);
    let taps = render(&gpu, pan(0.0), [WIDTH, HEIGHT]);
    let path_shift = edge_shift_px(&path);
    let taps_shift = edge_shift_px(&taps);

    assert!(
        (path_shift - 20.0).abs() < 0.75,
        "path kernel shift {path_shift:.2} px"
    );
    // The original kernel stops at 0.95 of the step and counts t = 0 twice.
    assert!(
        (taps_shift - 40.0 * 9.5 / 21.0).abs() < 0.75,
        "tap kernel shift {taps_shift:.2} px"
    );
    let reach = edge_reach_px(&path);
    assert!((38..=41).contains(&reach), "path kernel reach {reach} px");
}

#[test]
fn zoom_path_kernel_weights_the_ray_evenly() {
    let Some(gpu) = gpu() else { return };
    // A radial blur toward the card's right edge: near the black/white edge
    // the rays run along x and are 40 px long. Both kernels centre the light
    // at half the ray; even weights carry more of it to the ray's far end.
    let zoom = |kernel| CompositeVideoFrameUniforms {
        motion_blur_zoom_center: [1.0, 0.5],
        motion_blur_params: [2.0, 1.0, 0.2, 0.0],
        ..card(kernel)
    };
    let path = render(&gpu, zoom(1.0), [WIDTH, HEIGHT]);
    let taps = render(&gpu, zoom(0.0), [WIDTH, HEIGHT]);
    let ray = 40.0;
    for (name, pixels) in [("path", &path), ("tap", &taps)] {
        let shift = edge_shift_px(pixels);
        assert!(
            (shift - ray / 2.0).abs() < 1.5,
            "{name} kernel shift {shift:.2} px"
        );
    }
    // 32 px out, 0.8 of the ray: a fifth of the even taps reach the white
    // side against about a tenth of the parabolic weight.
    let light = |pixels: &[u8]| {
        let x = WIDTH / 2 - 32;
        (HEIGHT / 4..HEIGHT * 3 / 4)
            .map(|y| pixels[((y * WIDTH + x) * 4) as usize] as f64)
            .sum::<f64>()
            / (HEIGHT / 2) as f64
    };
    let (path_light, tap_light) = (light(&path), light(&taps));
    assert!(
        (path_light - 0.2 * 255.0).abs() < 12.0 && tap_light < path_light - 12.0,
        "light at 0.8 of the ray: path {path_light:.1}, taps {tap_light:.1}"
    );
}

#[test]
fn shadow_trails_with_the_card_only_on_the_path_kernel() {
    let Some(gpu) = gpu() else { return };
    // A 400 x 200 card at (60, 60) with a soft shadow, moving 24 px right.
    let output = [520, 320];
    let moving = |kernel, vector: [f32; 2]| CompositeVideoFrameUniforms {
        output_size: [output[0] as f32, output[1] as f32],
        target_bounds: [60.0, 60.0, 460.0, 260.0],
        target_size: [400.0, 200.0],
        shadow: 50.0,
        shadow_size: 0.0,
        shadow_opacity: 60.0,
        shadow_blur: 100.0,
        motion_blur_vector: vector,
        motion_blur_params: if vector == [0.0; 2] {
            [0.0; 4]
        } else {
            [1.0, 1.0, 0.0, 0.0]
        },
        ..card(kernel)
    };
    let alpha_at = |pixels: &[u8], x: u32, y: u32| pixels[((y * output[0] + x) * 4 + 3) as usize];
    let vector = [24.0 / 400.0, 0.0];
    let still = render(&gpu, moving(1.0, [0.0; 2]), output);
    let path = render(&gpu, moving(1.0, vector), output);
    let taps = render(&gpu, moving(0.0, vector), output);
    // 30 px left of the card, past the smear: over the last frame the card
    // stood up to 24 px closer, so the trailed shadow there is stronger.
    let (x, y) = (30, 160);
    assert_eq!(alpha_at(&taps, x, y), alpha_at(&still, x, y));
    assert!(
        alpha_at(&path, x, y) > alpha_at(&still, x, y) + 4,
        "trailed {} against still {}",
        alpha_at(&path, x, y),
        alpha_at(&still, x, y)
    );
}
