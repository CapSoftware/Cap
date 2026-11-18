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
        eprintln!("no GPU adapter available, skipping downscale filter tests");
        return None;
    };
    eprintln!("Downscale filter adapter: {:?}", adapter.get_info());
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .expect("create downscale filter test device");
    let pipeline = CompositeVideoFramePipeline::new(&device);
    Some(Gpu {
        device,
        queue,
        pipeline,
    })
}

struct Source {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

impl Source {
    fn from_fn(width: u32, height: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Self {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                rgba.extend_from_slice(&f(x, y));
            }
        }
        Self {
            width,
            height,
            rgba,
        }
    }
}

struct Draw {
    output: [u32; 2],
    crop: [f32; 4],
    target: [f32; 4],
    preserve_alpha: bool,
}

fn render(gpu: &Gpu, source: &Source, draw: &Draw) -> Vec<u8> {
    let Gpu {
        device,
        queue,
        pipeline,
    } = gpu;
    let frame = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width: source.width,
            height: source.height,
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
        &source.rgba,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(source.width * 4),
            rows_per_image: Some(source.height),
        },
        frame.size(),
    );
    let [width, height] = draw.output;
    let target_size = [
        draw.target[2] - draw.target[0],
        draw.target[3] - draw.target[1],
    ];
    let uniforms = CompositeVideoFrameUniforms {
        output_size: [width as f32, height as f32],
        frame_size: [source.width as f32, source.height as f32],
        crop_bounds: draw.crop,
        target_bounds: draw.target,
        target_size,
        rounding_px: 0.0,
        corner_radii: [0.0; 4],
        preserve_source_alpha: if draw.preserve_alpha { 1.0 } else { 0.0 },
        ..Default::default()
    };
    let frame_view = frame.create_view(&Default::default());
    let uniforms_buffer = uniforms.to_buffer(device);
    let bind_group = pipeline.bind_group(device, &uniforms_buffer, &frame_view);
    let output = device.create_texture(&wgpu::TextureDescriptor {
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
        let view = output.create_view(&Default::default());
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
            texture: &output,
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
        output.size(),
    );
    queue.submit([encoder.finish()]);
    readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    device
        .poll(wgpu::PollType::Wait)
        .expect("wait for downscale readback");
    let mapped = readback.slice(..).get_mapped_range();
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for row in 0..height {
        let start = (row * padded_row) as usize;
        pixels.extend_from_slice(&mapped[start..start + (width * 4) as usize]);
    }
    pixels
}

fn full_frame_draw(source: &Source, output: [u32; 2]) -> Draw {
    Draw {
        output,
        crop: [0.0, 0.0, source.width as f32, source.height as f32],
        target: [0.0, 0.0, output[0] as f32, output[1] as f32],
        preserve_alpha: false,
    }
}

fn luma_spread(pixels: &[u8], width: u32, inset: u32) -> (f64, f64) {
    let height = pixels.len() as u32 / 4 / width;
    let mut values = Vec::new();
    for y in inset..height - inset {
        for x in inset..width - inset {
            values.push(pixels[((y * width + x) * 4 + 1) as usize] as f64);
        }
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64;
    (mean, variance.sqrt())
}

#[test]
fn one_to_one_draw_returns_the_source() {
    let Some(gpu) = gpu() else { return };
    let source = Source::from_fn(96, 64, |x, y| {
        let v = ((x * 37 + y * 91 + (x * y) % 13 * 17) % 256) as u8;
        [v, v.wrapping_mul(3), 255 - v, 255]
    });
    let pixels = render(&gpu, &source, &full_frame_draw(&source, [96, 64]));
    for y in 3..61 {
        for x in 3..93 {
            let at = ((y * 96 + x) * 4) as usize;
            assert_eq!(pixels[at..at + 4], source.rgba[at..at + 4], "pixel {x},{y}");
        }
    }
}

#[test]
fn shrunk_one_pixel_stripes_average_instead_of_beating() {
    let Some(gpu) = gpu() else { return };
    let source = Source::from_fn(192, 96, |x, _| {
        let v = if x % 2 == 0 { 0 } else { 255 };
        [v, v, v, 255]
    });
    let output = [128, 64];
    for preserve_alpha in [false, true] {
        let draw = Draw {
            preserve_alpha,
            ..full_frame_draw(&source, output)
        };
        let pixels = render(&gpu, &source, &draw);
        let (mean, spread) = luma_spread(&pixels, output[0], 3);
        // A 1.5x shrink of 1 px stripes is above the output's Nyquist limit, so
        // the ideal result is flat mid grey. One tap plus an unsharp mask left a
        // full-contrast beat pattern (spread about 92 levels); four box taps
        // bring it to about 32.
        assert!(
            (mean - 127.5).abs() < 4.0,
            "preserve_alpha {preserve_alpha}: mean {mean:.1}"
        );
        assert!(
            spread < 45.0,
            "preserve_alpha {preserve_alpha}: spread {spread:.1}"
        );
    }
}

#[test]
fn shrunk_cutout_edges_keep_their_colour() {
    let Some(gpu) = gpu() else { return };
    // White foreground on transparent black, as a background-removed camera
    // frame: shrinking must soften the edge alpha without pulling in the
    // colour hidden under the transparent texels.
    let source = Source::from_fn(192, 96, |x, y| {
        if (40..150).contains(&x) && (20..76).contains(&y) {
            [255, 255, 255, 255]
        } else {
            [0, 0, 0, 0]
        }
    });
    let draw = Draw {
        preserve_alpha: true,
        ..full_frame_draw(&source, [64, 32])
    };
    let pixels = render(&gpu, &source, &draw);
    let mut edge_pixels = 0;
    for (index, pixel) in pixels.chunks_exact(4).enumerate() {
        let (x, y) = (index as u32 % 64, index as u32 / 64);
        // Output pixel n centres on source texel 3n + 1; where that texel is
        // opaque the shrink filter runs, and its result blended over the
        // transparent clear colour must be white scaled by its alpha.
        let (cx, cy) = (3 * x + 1, 3 * y + 1);
        if !((40..150).contains(&cx) && (20..76).contains(&cy)) {
            continue;
        }
        let alpha = pixel[3] as i32;
        for channel in &pixel[..3] {
            assert!(
                (*channel as i32 - alpha).abs() <= 2,
                "pixel {x},{y} is {pixel:?}"
            );
        }
        if alpha < 255 {
            edge_pixels += 1;
        }
    }
    assert!(
        edge_pixels > 0,
        "the shrunk edge should be partly transparent"
    );
}

#[test]
fn heavily_shrunk_stripes_stay_flat() {
    let Some(gpu) = gpu() else { return };
    // A 1 px stripe pattern shrunk 3.3x, as a Retina recording in a 720p
    // export. A 2x2 box of bilinear taps passed about a third of the stripe
    // contrast as a beat (spread about 62 levels); the turned ring takes it to
    // about 9.
    let source = Source::from_fn(330, 99, |x, _| {
        let v = if x % 2 == 0 { 0 } else { 255 };
        [v, v, v, 255]
    });
    let output = [100, 30];
    let pixels = render(&gpu, &source, &full_frame_draw(&source, output));
    let (mean, spread) = luma_spread(&pixels, output[0], 4);
    assert!((mean - 127.5).abs() < 4.0, "mean {mean:.1}");
    assert!(spread < 25.0, "spread {spread:.1}");
}
