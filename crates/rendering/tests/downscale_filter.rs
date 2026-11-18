use cap_rendering::{
    composite_frame::{CompositeVideoFramePipeline, CompositeVideoFrameUniforms},
    downscale::DownscalePrefilter,
};

/// Whether the draw goes through the downscale prefilter, as the display
/// and camera layers do, or straight to the composite as before.
#[derive(Clone, Copy, Debug, PartialEq)]
enum DownscaleFilter {
    Bilinear,
    Lanczos,
}

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
    filter: DownscaleFilter,
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
        ..Default::default()
    };
    let frame_view = frame.create_view(&Default::default());
    let uniforms_buffer = uniforms.to_buffer(device);
    let plain_bind_group = pipeline.bind_group(device, &uniforms_buffer, &frame_view);
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
    let mut prefilter = DownscalePrefilter::new(device);
    if draw.filter == DownscaleFilter::Lanczos {
        prefilter.encode(
            device,
            queue,
            &mut encoder,
            pipeline,
            [source.width, source.height],
            &frame_view,
            &uniforms,
        );
    }
    let bind_group = prefilter.bind_group().unwrap_or(&plain_bind_group);
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
        pass.set_bind_group(0, bind_group, &[]);
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

fn full_frame_draw(source: &Source, output: [u32; 2], filter: DownscaleFilter) -> Draw {
    Draw {
        output,
        crop: [0.0, 0.0, source.width as f32, source.height as f32],
        target: [0.0, 0.0, output[0] as f32, output[1] as f32],
        filter,
    }
}

fn detailed_source() -> Source {
    Source::from_fn(96, 64, |x, y| {
        let v = ((x * 37 + y * 91 + (x * y) % 13 * 17) % 256) as u8;
        [v, v.wrapping_mul(3), 255 - v, 255]
    })
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
fn one_to_one_and_magnified_draws_ignore_the_downscale_filter() {
    let Some(gpu) = gpu() else { return };
    let source = detailed_source();
    for output in [[96, 64], [192, 128], [130, 87]] {
        let bilinear = render(
            &gpu,
            &source,
            &full_frame_draw(&source, output, DownscaleFilter::Bilinear),
        );
        let lanczos = render(
            &gpu,
            &source,
            &full_frame_draw(&source, output, DownscaleFilter::Lanczos),
        );
        assert!(bilinear == lanczos, "{output:?} changed with the filter on");
    }
}

#[test]
fn downscale_filter_resolves_one_pixel_stripes_without_moire() {
    let Some(gpu) = gpu() else { return };
    let source = Source::from_fn(192, 96, |x, _| {
        let v = if x % 2 == 0 { 0 } else { 255 };
        [v, v, v, 255]
    });
    let output = [128, 64];
    let lanczos = render(
        &gpu,
        &source,
        &full_frame_draw(&source, output, DownscaleFilter::Lanczos),
    );
    let bilinear = render(
        &gpu,
        &source,
        &full_frame_draw(&source, output, DownscaleFilter::Bilinear),
    );
    let (lanczos_mean, lanczos_spread) = luma_spread(&lanczos, output[0], 3);
    let (_, bilinear_spread) = luma_spread(&bilinear, output[0], 3);
    // A 1.5x shrink of 1 px stripes is above the output's Nyquist limit, so
    // the ideal result is flat mid grey. One bilinear tap beats against the
    // stripes and leaves a strong pattern.
    assert!((lanczos_mean - 127.5).abs() < 4.0, "mean {lanczos_mean:.1}");
    assert!(lanczos_spread < 12.0, "lanczos spread {lanczos_spread:.1}");
    assert!(
        bilinear_spread > lanczos_spread * 3.0,
        "bilinear spread {bilinear_spread:.1} vs lanczos {lanczos_spread:.1}"
    );
}

#[test]
fn downscale_filter_keeps_flat_colour_and_stays_inside_the_crop() {
    let Some(gpu) = gpu() else { return };
    // A flat teal crop inside a red border: the filter must neither tint
    // the edge with the border nor change the flat colour.
    let source = Source::from_fn(160, 120, |x, y| {
        if (20..140).contains(&x) && (10..110).contains(&y) {
            [20, 160, 150, 255]
        } else {
            [255, 0, 0, 255]
        }
    });
    let draw = Draw {
        output: [80, 50],
        crop: [20.0, 10.0, 140.0, 110.0],
        target: [0.0, 0.0, 80.0, 50.0],
        filter: DownscaleFilter::Lanczos,
    };
    let pixels = render(&gpu, &source, &draw);
    let [width, height] = draw.output;
    for (index, pixel) in pixels.chunks_exact(4).enumerate() {
        let (x, y) = (index as u32 % width, index as u32 / width);
        // The composite antialiases the card edge against the transparent
        // clear colour, so edge pixels carry less alpha, but every pixel must
        // still be the teal scaled by its alpha: no red from outside the crop.
        let alpha = pixel[3] as f32 / 255.0;
        for (channel, teal) in [20.0f32, 160.0, 150.0].into_iter().enumerate() {
            let expected = teal * alpha;
            assert!(
                (pixel[channel] as f32 - expected).abs() <= 1.5,
                "pixel {x},{y} is {pixel:?}"
            );
        }
        if (3..width - 3).contains(&x) && (3..height - 3).contains(&y) {
            assert_eq!(pixel, [20, 160, 150, 255], "pixel {x},{y}");
        }
    }
}
