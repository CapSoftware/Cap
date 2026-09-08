//! Before/after benchmark for the editor preview's zero-copy surface handoff.
//!
//! "Before" is the NV12 path this repo shipped until the BGRA change: a
//! compute pass converting the rendered RGBA frame into the Y/UV planes of a
//! 420f IOSurface, painted by gpui with a two-texture YCbCr matrix sample.
//! That code is gone from production, so this example carries a faithful
//! reimplementation (same bind groups, same dispatch geometry, same pool).
//!
//! "After" is the production `RgbaToBgraSurfaceConverter`: a fullscreen
//! triangle blit into a 32BGRA IOSurface, painted with a single passthrough
//! sample.
//!
//! Both paths run on the same device against the same source texture, with
//! identical submit-and-wait harnesses, alternating iterations so GPU clock
//! ramping hits them equally. Two phases are timed per path:
//!
//! * convert — encode + submit + wait for the conversion pass (the renderer
//!   side of the handoff, what `finish_encoder_bgra_surface` pays).
//! * paint — sampling the converted surface into a BGRA target, simulating
//!   gpui's `draw_surfaces` fragment work.
//!
//! Run: `cargo run -p cap-rendering --example preview-surface-benchmark --release`

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This benchmark compares IOSurface preview paths and is macOS-only.");
}

#[cfg(target_os = "macos")]
fn main() {
    macos::run();
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::Instant;

    use cap_rendering::RgbaToBgraSurfaceConverter;
    use cap_rendering::iosurface_texture::{
        IOSurfaceTextureCache, import_metal_texture_to_wgpu_with_usage,
    };
    use cidre::{arc, cf, cv, mtl};

    const SIZES: [(u32, u32); 3] = [(1248, 702), (1920, 1080), (3840, 2160)];
    const WARMUP: usize = 30;
    const ITERATIONS: usize = 300;

    const NV12_CONVERT_SHADER: &str = r#"
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var y_out: texture_storage_2d<r8unorm, write>;
@group(0) @binding(2) var uv_out: texture_storage_2d<rg8unorm, write>;
struct Params { width: u32, height: u32, _pad0: u32, _pad1: u32 }
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let base = gid.xy * 2u;
    if (base.x >= params.width || base.y >= params.height) {
        return;
    }
    var sum_uv = vec2<f32>(0.0, 0.0);
    for (var dy = 0u; dy < 2u; dy += 1u) {
        for (var dx = 0u; dx < 2u; dx += 1u) {
            let coord = min(base + vec2<u32>(dx, dy),
                            vec2<u32>(params.width - 1u, params.height - 1u));
            let rgb = textureLoad(source, vec2<i32>(coord), 0).rgb;
            let y = dot(rgb, vec3<f32>(0.299, 0.587, 0.114));
            textureStore(y_out, vec2<i32>(coord), vec4<f32>(y, 0.0, 0.0, 1.0));
            sum_uv += vec2<f32>(
                dot(rgb, vec3<f32>(-0.169, -0.331, 0.5)),
                dot(rgb, vec3<f32>(0.5, -0.419, -0.081)),
            );
        }
    }
    textureStore(uv_out, vec2<i32>(gid.xy), vec4<f32>(sum_uv * 0.25 + 0.5, 0.0, 1.0));
}
"#;

    const PAINT_SHADER: &str = r#"
@group(0) @binding(0) var color_texture: texture_2d<f32>;
@group(0) @binding(1) var uv_texture: texture_2d<f32>;
@group(0) @binding(2) var color_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) tex_coord: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    var out: VertexOutput;
    out.position = vec4<f32>(positions[index], 0.0, 1.0);
    out.tex_coord = positions[index] * vec2<f32>(0.5, -0.5) + 0.5;
    return out;
}

// gpui's surface_fragment: two-plane YCbCr sample plus the matrix multiply.
@fragment
fn fs_nv12(in: VertexOutput) -> @location(0) vec4<f32> {
    let y = textureSample(color_texture, color_sampler, in.tex_coord).r;
    let uv = textureSample(uv_texture, color_sampler, in.tex_coord).rg - 0.5;
    let rgb = vec3<f32>(
        y + 1.402 * uv.y,
        y - 0.344 * uv.x - 0.714 * uv.y,
        y + 1.772 * uv.x,
    );
    return vec4<f32>(rgb, 1.0);
}

// gpui's surface_bgra_fragment: one passthrough sample.
@fragment
fn fs_bgra(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(textureSample(color_texture, color_sampler, in.tex_coord).rgb, 1.0);
}
"#;

    /// The pre-change production converter, reconstructed: RGBA -> NV12 into a
    /// pooled 420f IOSurface via one compute dispatch covering 2x2 pixels per
    /// invocation.
    struct Nv12Converter {
        pipeline: wgpu::ComputePipeline,
        bind_group_layout: wgpu::BindGroupLayout,
        params_buffer: wgpu::Buffer,
        /// Keeps the IOSurface backing the imported Y/UV textures alive.
        _pixel_buffer: arc::R<cv::PixelBuf>,
        y_texture: wgpu::Texture,
        uv_texture: wgpu::Texture,
    }

    impl Nv12Converter {
        fn new(
            device: &wgpu::Device,
            queue: &wgpu::Queue,
            cache: &IOSurfaceTextureCache,
            width: u32,
            height: u32,
        ) -> Self {
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("NV12 Convert (before)"),
                source: wgpu::ShaderSource::Wgsl(NV12_CONVERT_SHADER.into()),
            });
            let bind_group_layout =
                device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: None,
                    entries: &[
                        wgpu::BindGroupLayoutEntry {
                            binding: 0,
                            visibility: wgpu::ShaderStages::COMPUTE,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 1,
                            visibility: wgpu::ShaderStages::COMPUTE,
                            ty: wgpu::BindingType::StorageTexture {
                                access: wgpu::StorageTextureAccess::WriteOnly,
                                format: wgpu::TextureFormat::R8Unorm,
                                view_dimension: wgpu::TextureViewDimension::D2,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 2,
                            visibility: wgpu::ShaderStages::COMPUTE,
                            ty: wgpu::BindingType::StorageTexture {
                                access: wgpu::StorageTextureAccess::WriteOnly,
                                format: wgpu::TextureFormat::Rg8Unorm,
                                view_dimension: wgpu::TextureViewDimension::D2,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 3,
                            visibility: wgpu::ShaderStages::COMPUTE,
                            ty: wgpu::BindingType::Buffer {
                                ty: wgpu::BufferBindingType::Uniform,
                                has_dynamic_offset: false,
                                min_binding_size: None,
                            },
                            count: None,
                        },
                    ],
                });
            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None,
                bind_group_layouts: &[&bind_group_layout],
                push_constant_ranges: &[],
            });
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("NV12 Convert Pipeline (before)"),
                layout: Some(&layout),
                module: &shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
            let params_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: 16,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            queue.write_buffer(
                &params_buffer,
                0,
                bytemuck::bytes_of(&[width, height, 0u32, 0u32]),
            );

            let pixel_buffer = alloc_pixel_buffer(cv::PixelFormat::_420F, width, height);
            let io_surface = pixel_buffer.io_surf().expect("nv12 iosurface");
            let usage = mtl::TextureUsage::SHADER_READ | mtl::TextureUsage::SHADER_WRITE;
            let metal_y = cache
                .create_y_texture_with_usage(io_surface, width, height, usage)
                .expect("y plane");
            let metal_uv = cache
                .create_uv_texture_with_usage(io_surface, width, height, usage)
                .expect("uv plane");
            let wgpu_usage =
                wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING;
            let y_texture = import_metal_texture_to_wgpu_with_usage(
                device,
                &metal_y,
                wgpu::TextureFormat::R8Unorm,
                width,
                height,
                wgpu_usage,
                Some("bench nv12 y"),
            )
            .expect("import y");
            let uv_texture = import_metal_texture_to_wgpu_with_usage(
                device,
                &metal_uv,
                wgpu::TextureFormat::Rg8Unorm,
                width / 2,
                height / 2,
                wgpu_usage,
                Some("bench nv12 uv"),
            )
            .expect("import uv");

            Self {
                pipeline,
                bind_group_layout,
                params_buffer,
                _pixel_buffer: pixel_buffer,
                y_texture,
                uv_texture,
            }
        }

        fn encode(
            &self,
            device: &wgpu::Device,
            encoder: &mut wgpu::CommandEncoder,
            source: &wgpu::TextureView,
            width: u32,
            height: u32,
        ) {
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(source),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(
                            &self.y_texture.create_view(&Default::default()),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(
                            &self.uv_texture.create_view(&Default::default()),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: self.params_buffer.as_entire_binding(),
                    },
                ],
            });
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(width.div_ceil(16), height.div_ceil(16), 1);
        }
    }

    fn alloc_pixel_buffer(
        format: cv::PixelFormat,
        width: u32,
        height: u32,
    ) -> arc::R<cv::PixelBuf> {
        let width_number = cf::Number::from_usize(width as usize);
        let height_number = cf::Number::from_usize(height as usize);
        let io_surface_properties = cf::Dictionary::new();
        let keys: [&cf::Type; 5] = [
            cv::pixel_buffer::keys::pixel_format().as_ref(),
            cv::pixel_buffer::keys::width().as_ref(),
            cv::pixel_buffer::keys::height().as_ref(),
            cv::pixel_buffer::keys::io_surf_props().as_ref(),
            cv::pixel_buffer::keys::metal_compatibility().as_ref(),
        ];
        let values: [&cf::Type; 5] = [
            format.to_cf_number().as_ref(),
            width_number.as_ref(),
            height_number.as_ref(),
            io_surface_properties.as_ref(),
            cf::Boolean::value_true().as_ref(),
        ];
        let attributes =
            cf::Dictionary::with_keys_values(&keys, &values).expect("pixel buffer attributes");
        let pool = cv::PixelBufPool::new(None, Some(attributes.as_ref())).expect("pool");
        pool.pixel_buf().expect("pixel buffer")
    }

    fn submit_and_wait(device: &wgpu::Device, queue: &wgpu::Queue, encoder: wgpu::CommandEncoder) {
        queue.submit(std::iter::once(encoder.finish()));
        let done = Arc::new(AtomicBool::new(false));
        let signal = Arc::clone(&done);
        queue.on_submitted_work_done(move || signal.store(true, Ordering::Release));
        while !done.load(Ordering::Acquire) {
            let _ = device.poll(wgpu::PollType::Poll);
            std::hint::spin_loop();
        }
    }

    struct Stats {
        mean_us: f64,
        p50_us: f64,
        p95_us: f64,
    }

    fn stats(mut samples: Vec<f64>) -> Stats {
        samples.sort_by(|a, b| a.total_cmp(b));
        let mean_us = samples.iter().sum::<f64>() / samples.len() as f64;
        Stats {
            mean_us,
            p50_us: samples[samples.len() / 2],
            p95_us: samples[samples.len() * 95 / 100],
        }
    }

    struct PaintPass {
        pipeline: wgpu::RenderPipeline,
        bind_group: wgpu::BindGroup,
        target_view: wgpu::TextureView,
    }

    impl PaintPass {
        fn encode(&self, encoder: &mut wgpu::CommandEncoder) {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.target_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
    }

    fn paint_pass(
        device: &wgpu::Device,
        shader: &wgpu::ShaderModule,
        entry_point: &str,
        views: [&wgpu::TextureView; 2],
        sampler: &wgpu::Sampler,
        size: (u32, u32),
    ) -> PaintPass {
        let (width, height) = size;
        let [color, uv] = views;
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(entry_point),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: shader,
                entry_point: Some(entry_point),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Bgra8Unorm,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(color),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(uv),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        });
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("paint target"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Bgra8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        PaintPass {
            pipeline,
            bind_group,
            target_view: target.create_view(&Default::default()),
        }
    }

    pub fn run() {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::METAL,
            ..Default::default()
        });
        let adapter = pollster_block(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))
        .expect("adapter");
        println!("adapter: {}", adapter.get_info().name);
        // Same optional feature set RenderVideoConstants requests; the NV12
        // path's R8/RG8 storage textures need the adapter-specific formats.
        let mut required_features = wgpu::Features::empty();
        if adapter
            .features()
            .contains(wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES)
        {
            required_features |= wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES;
        }
        let (device, queue) = pollster_block(adapter.request_device(&wgpu::DeviceDescriptor {
            required_features,
            ..Default::default()
        }))
        .expect("device");
        let cache = IOSurfaceTextureCache::new().expect("metal device");

        println!(
            "{:>11} | {:>7} | {:>8} | mean / p50 / p95 (us)",
            "resolution", "path", "phase"
        );

        for (width, height) in SIZES {
            let source = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("bench source"),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let mut pixels = vec![0u8; (width * height * 4) as usize];
            for y in 0..height {
                for x in 0..width {
                    let i = ((y * width + x) * 4) as usize;
                    pixels[i] = (x * 255 / width) as u8;
                    pixels[i + 1] = (y * 255 / height) as u8;
                    pixels[i + 2] = ((x + y) % 256) as u8;
                    pixels[i + 3] = 255;
                }
            }
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &source,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &pixels,
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
            let source_view = source.create_view(&Default::default());

            let nv12 = Nv12Converter::new(&device, &queue, &cache, width, height);
            let mut bgra =
                RgbaToBgraSurfaceConverter::new(&device).expect("bgra surface converter");

            // Convert once through each so pools/pipelines exist, and keep the
            // BGRA surface for the paint phase.
            let mut nv12_encoder = device.create_command_encoder(&Default::default());
            nv12.encode(&device, &mut nv12_encoder, &source_view, width, height);
            submit_and_wait(&device, &queue, nv12_encoder);
            let mut bgra_encoder = device.create_command_encoder(&Default::default());
            let pending = bgra
                .encode(&device, &mut bgra_encoder, &source, width, height, 0, 60)
                .expect("bgra encode");
            submit_and_wait(&device, &queue, bgra_encoder);
            let bgra_frame = pollster_block(pending.wait(&device, &queue)).expect("bgra frame");

            // Paint-phase inputs: sampled imports of the converted surfaces,
            // mirroring what gpui's CVMetalTextureCache hands its fragment.
            let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            });
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("paint sim"),
                source: wgpu::ShaderSource::Wgsl(PAINT_SHADER.into()),
            });
            let bgra_surface = bgra_frame.pixel_buffer.io_surf().expect("bgra iosurface");
            let bgra_metal = cache
                .create_bgra_texture(bgra_surface, width, height)
                .expect("bgra sampled");
            let bgra_sampled = import_metal_texture_to_wgpu_with_usage(
                &device,
                &bgra_metal,
                wgpu::TextureFormat::Bgra8Unorm,
                width,
                height,
                wgpu::TextureUsages::TEXTURE_BINDING,
                Some("bench bgra sampled"),
            )
            .expect("import bgra")
            .create_view(&Default::default());
            let y_view = nv12.y_texture.create_view(&Default::default());
            let uv_view = nv12.uv_texture.create_view(&Default::default());

            let nv12_paint = paint_pass(
                &device,
                &shader,
                "fs_nv12",
                [&y_view, &uv_view],
                &sampler,
                (width, height),
            );
            let bgra_paint = paint_pass(
                &device,
                &shader,
                "fs_bgra",
                [&bgra_sampled, &bgra_sampled],
                &sampler,
                (width, height),
            );

            let mut convert_nv12 = Vec::with_capacity(ITERATIONS);
            let mut convert_bgra = Vec::with_capacity(ITERATIONS);
            let mut paint_nv12 = Vec::with_capacity(ITERATIONS);
            let mut paint_bgra = Vec::with_capacity(ITERATIONS);

            for i in 0..WARMUP + ITERATIONS {
                let measured = i >= WARMUP;

                let start = Instant::now();
                let mut encoder = device.create_command_encoder(&Default::default());
                nv12.encode(&device, &mut encoder, &source_view, width, height);
                submit_and_wait(&device, &queue, encoder);
                if measured {
                    convert_nv12.push(start.elapsed().as_secs_f64() * 1e6);
                }

                let start = Instant::now();
                let mut encoder = device.create_command_encoder(&Default::default());
                let _pending = bgra
                    .encode(&device, &mut encoder, &source, width, height, 0, 60)
                    .expect("bgra encode");
                submit_and_wait(&device, &queue, encoder);
                if measured {
                    convert_bgra.push(start.elapsed().as_secs_f64() * 1e6);
                }

                let start = Instant::now();
                let mut encoder = device.create_command_encoder(&Default::default());
                nv12_paint.encode(&mut encoder);
                submit_and_wait(&device, &queue, encoder);
                if measured {
                    paint_nv12.push(start.elapsed().as_secs_f64() * 1e6);
                }

                let start = Instant::now();
                let mut encoder = device.create_command_encoder(&Default::default());
                bgra_paint.encode(&mut encoder);
                submit_and_wait(&device, &queue, encoder);
                if measured {
                    paint_bgra.push(start.elapsed().as_secs_f64() * 1e6);
                }
            }

            let rows = [
                ("nv12", "convert", stats(convert_nv12)),
                ("bgra", "convert", stats(convert_bgra)),
                ("nv12", "paint", stats(paint_nv12)),
                ("bgra", "paint", stats(paint_bgra)),
            ];
            for (path, phase, s) in rows {
                println!(
                    "{:>4}x{:<6} | {:>7} | {:>8} | {:>8.1} / {:>8.1} / {:>8.1}",
                    width, height, path, phase, s.mean_us, s.p50_us, s.p95_us
                );
            }
        }
    }

    fn pollster_block<F: std::future::Future>(future: F) -> F::Output {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        runtime.block_on(future)
    }
}
