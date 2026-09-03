use std::borrow::Cow;

use wgpu::util::DeviceExt;

const SHADER: &str = include_str!("../src/shaders/cursor.wgsl");
const OUTPUT_WIDTH: u32 = 192;
const OUTPUT_HEIGHT: u32 = 128;
const TEXTURE_WIDTH: u32 = 64;
const TEXTURE_HEIGHT: u32 = 128;

#[derive(Clone, Copy, Debug)]
struct Case {
    height: f32,
    rotation: f32,
    offset: [f32; 2],
    motion: [f32; 2],
}

impl Case {
    fn uniforms(self) -> [[f32; 4]; 8] {
        [
            [
                96.0 + self.offset[0],
                38.0 + self.offset[1],
                self.height * TEXTURE_WIDTH as f32 / TEXTURE_HEIGHT as f32,
                self.height,
            ],
            [OUTPUT_WIDTH as f32, OUTPUT_HEIGHT as f32, 0.0, 0.0],
            [0.0, 0.0, OUTPUT_WIDTH as f32, OUTPUT_HEIGHT as f32],
            [self.motion[0], self.motion[1], 1.0, 1.0],
            [0.0, self.rotation, 0.0, 0.0],
            [0.0; 4],
            [0.0; 4],
            [0.0; 4],
        ]
    }
}

fn reference_shader() -> String {
    // Capture gradients before any sprite-boundary branch, including every blur tap.
    let replacements = [
        (
            "fn sample_cursor(uv: vec2<f32>)",
            "fn sample_cursor(uv: vec2<f32>, gradient_x: vec2<f32>, gradient_y: vec2<f32>)",
        ),
        (
            "textureSample(t_cursor, s_cursor, uv)",
            "textureSampleGrad(t_cursor, s_cursor, uv, gradient_x, gradient_y)",
        ),
        (
            "sample_cursor(input.uv)",
            "sample_cursor(input.uv, dpdx(input.uv), dpdy(input.uv))",
        ),
        (
            "sample_cursor(sample_uv)",
            "sample_cursor(sample_uv, dpdx(sample_uv), dpdy(sample_uv))",
        ),
    ];
    let mut source = SHADER.to_string();
    for (from, to) in replacements {
        assert_eq!(source.matches(from).count(), 1);
        source = source.replace(from, to);
    }
    source
}

fn pipeline(device: &wgpu::Device, source: &str) -> wgpu::RenderPipeline {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Cursor edge regression"),
        source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(source)),
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Cursor edge regression"),
        layout: None,
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
                blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleStrip,
            ..Default::default()
        },
        depth_stencil: None,
        multisample: Default::default(),
        multiview: None,
        cache: None,
    })
}

fn mip_texture(device: &wgpu::Device, queue: &wgpu::Queue) -> wgpu::Texture {
    let colors = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 0],
        [255, 0, 255],
        [0, 255, 255],
        [128, 128, 128],
        [255, 255, 255],
    ];
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Distinct cursor mip levels"),
        size: wgpu::Extent3d {
            width: TEXTURE_WIDTH,
            height: TEXTURE_HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: colors.len() as u32,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    for (level, color) in colors.into_iter().enumerate() {
        let width = (TEXTURE_WIDTH >> level).max(1);
        let height = (TEXTURE_HEIGHT >> level).max(1);
        let mut bytes = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let u = (x as f32 + 0.5) / width as f32;
                let v = (y as f32 + 0.5) / height as f32;
                let pixel = if (0.15..0.85).contains(&u) && (0.15..0.85).contains(&v) {
                    [color[0], color[1], color[2], 255]
                } else {
                    [0; 4]
                };
                bytes.extend_from_slice(&pixel);
            }
        }
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: level as u32,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &bytes,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
    }
    texture
}

fn render(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    pipeline: &wgpu::RenderPipeline,
    cursor: &wgpu::TextureView,
    sampler: &wgpu::Sampler,
    case: Case,
) -> Vec<u8> {
    let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Cursor edge uniforms"),
        contents: bytemuck::cast_slice(&case.uniforms()),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(cursor),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(sampler),
            },
        ],
    });
    let output = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Cursor edge output"),
        size: wgpu::Extent3d {
            width: OUTPUT_WIDTH,
            height: OUTPUT_HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Cursor edge readback"),
        size: u64::from(OUTPUT_WIDTH * OUTPUT_HEIGHT * 4),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let view = output.create_view(&Default::default());
    let mut encoder = device.create_command_encoder(&Default::default());
    {
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
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..4, 0..1);
    }
    encoder.copy_texture_to_buffer(
        output.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(OUTPUT_WIDTH * 4),
                rows_per_image: Some(OUTPUT_HEIGHT),
            },
        },
        output.size(),
    );
    queue.submit([encoder.finish()]);
    let (sender, receiver) = std::sync::mpsc::channel();
    buffer
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            sender
                .send(result)
                .expect("readback receiver remains alive");
        });
    device.poll(wgpu::PollType::Wait).expect("poll GPU");
    receiver
        .recv()
        .expect("readback callback")
        .expect("map GPU");
    let pixels = buffer.slice(..).get_mapped_range().to_vec();
    buffer.unmap();
    pixels
}

fn assert_transparent_exterior(pixels: &[u8], case: Case) {
    let [x, y, width, height] = case.uniforms()[0];
    let (s, c) = case.rotation.sin_cos();
    let mut velocity = [case.motion[0] / width, case.motion[1] / height];
    let length = velocity[0].hypot(velocity[1]);
    if length > 4.0 {
        velocity = velocity.map(|component| component * 4.0 / length);
    }
    let mut transparent_pixels = 0;
    for (index, pixel) in pixels.chunks_exact(4).enumerate() {
        let dx = (index as u32 % OUTPUT_WIDTH) as f32 + 0.5 - x;
        let dy = (index as u32 / OUTPUT_WIDTH) as f32 + 0.5 - y;
        let uv = [
            c * dx / width - s * dy / height,
            s * dx / width + c * dy / height,
        ];
        let outside = (0..21).all(|tap| {
            let sample = [
                uv[0] + velocity[0] * tap as f32 / 20.0,
                uv[1] + velocity[1] * tap as f32 / 20.0,
            ];
            sample.iter().any(|value| *value < -0.001 || *value > 1.001)
        });
        if outside {
            assert_eq!(pixel, [0; 4], "exterior pixel {index}, {case:?}");
            transparent_pixels += 1;
        }
    }
    assert!(transparent_pixels > 1_000);
}

#[test]
fn minified_cursor_edges_match_explicit_gradients() {
    let instance = cap_rendering::create_wgpu_instance_sync();
    let Ok(adapter) =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
    else {
        eprintln!("no GPU adapter available, skipping cursor edge regression");
        return;
    };
    eprintln!("Cursor edge adapter: {:?}", adapter.get_info());
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
            .expect("create cursor edge test device");
    let actual_pipeline = pipeline(&device, SHADER);
    let reference_pipeline = pipeline(&device, &reference_shader());
    let cursor = mip_texture(&device, &queue).create_view(&Default::default());
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::FilterMode::Linear,
        anisotropy_clamp: 4,
        ..Default::default()
    });
    for height in [6.4, 12.0, 25.0, 50.0] {
        for degrees in [-20.0_f32, 0.0, 20.0] {
            for offset in [[0.0, 0.0], [0.37, 0.63]] {
                for motion in [[0.0, 0.0], [36.0, 0.0], [-18.0, 13.0]] {
                    let case = Case {
                        height,
                        rotation: degrees.to_radians(),
                        offset,
                        motion,
                    };
                    let actual = render(&device, &queue, &actual_pipeline, &cursor, &sampler, case);
                    let expected = render(
                        &device,
                        &queue,
                        &reference_pipeline,
                        &cursor,
                        &sampler,
                        case,
                    );
                    assert!(expected.chunks_exact(4).any(|pixel| pixel[3] > 0));
                    let max_error = actual
                        .iter()
                        .zip(&expected)
                        .map(|(actual, expected)| actual.abs_diff(*expected))
                        .max()
                        .unwrap();
                    assert!(max_error <= 2, "mip edge error {max_error}/255, {case:?}");
                    assert_transparent_exterior(&actual, case);
                }
            }
        }
    }
}
