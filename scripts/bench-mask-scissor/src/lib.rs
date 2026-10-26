pub enum MaskRenderMode {
    Blur,
    Pixelate,
    Highlight,
}

pub struct XY<T> {
    pub x: T,
    pub y: T,
}

pub struct PreparedMask {
    pub mode: MaskRenderMode,
    pub center: XY<f32>,
    pub size: XY<f32>,
    pub feather: f32,
    pub opacity: f32,
    pub effect_size: f32,
    pub darkness: f32,
    pub output_size: XY<u32>,
}

pub struct RenderSession {
    views: [wgpu::TextureView; 2],
    current: usize,
}

impl RenderSession {
    fn current_texture_view(&self) -> &wgpu::TextureView {
        &self.views[self.current]
    }

    fn other_texture_view(&self) -> &wgpu::TextureView {
        &self.views[1 - self.current]
    }

    fn swap_textures(&mut self) {
        self.current = 1 - self.current;
    }
}

pub mod mask {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../crates/rendering/src/layers/mask.rs"
    ));

    #[cfg(test)]
    mod benchmark {
        use super::*;

        const WIDTH: u32 = 3840;
        const HEIGHT: u32 = 2160;
        const BATCH: u32 = 8;
        const SAMPLES: usize = 21;

        struct BlurPass {
            uniforms: MaskUniforms,
            bind_group: wgpu::BindGroup,
        }

        fn measure(
            device: &wgpu::Device,
            queue: &wgpu::Queue,
            layer: &MaskLayer,
            views: &[wgpu::TextureView; 2],
            passes: &[[BlurPass; 2]],
            scissored: bool,
        ) -> f64 {
            let mut encoder = device.create_command_encoder(&Default::default());
            for _ in 0..BATCH {
                for mask in passes {
                    for (axis, config) in mask.iter().enumerate() {
                        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                                view: &views[1 - axis],
                                resolve_target: None,
                                ops: wgpu::Operations {
                                    load: if axis == 0 {
                                        wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
                                    } else {
                                        wgpu::LoadOp::Load
                                    },
                                    store: wgpu::StoreOp::Store,
                                },
                            })],
                            ..Default::default()
                        });
                        pass.set_pipeline(if axis == 0 {
                            &layer.pipeline.render_pipeline
                        } else {
                            &layer.pipeline.blur_composite_pipeline
                        });
                        pass.set_bind_group(0, &config.bind_group, &[]);
                        if scissored {
                            config.uniforms.draw(&mut pass);
                        } else {
                            pass.draw(0..3, 0..1);
                        }
                    }
                }
            }
            let commands = encoder.finish();
            let started = std::time::Instant::now();
            queue.submit([commands]);
            device
                .poll(wgpu::PollType::Wait)
                .expect("poll benchmark GPU");
            started.elapsed().as_secs_f64() * 1_000.0 / f64::from(BATCH)
        }

        #[test]
        #[ignore = "requires a real GPU"]
        fn blur_scissor_benchmark() {
            let adapter =
                pollster::block_on(wgpu::Instance::default().request_adapter(&Default::default()))
                    .expect("request benchmark GPU adapter");
            let info = adapter.get_info();
            assert_ne!(info.backend, wgpu::Backend::Noop);
            let (device, queue) = pollster::block_on(adapter.request_device(&Default::default()))
                .expect("request benchmark GPU device");
            let layer = MaskLayer::new(&device);
            let size = wgpu::Extent3d {
                width: WIDTH,
                height: HEIGHT,
                depth_or_array_layers: 1,
            };
            let textures: [_; 2] = std::array::from_fn(|_| {
                device.create_texture(&wgpu::TextureDescriptor {
                    label: None,
                    size,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::RENDER_ATTACHMENT
                        | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                })
            });
            let views = textures
                .each_ref()
                .map(|texture| texture.create_view(&Default::default()));
            let pixels = (0..WIDTH * HEIGHT * 4)
                .map(|index| (index * 37 % 251) as u8)
                .collect::<Vec<_>>();
            queue.write_texture(
                textures[0].as_image_copy(),
                &pixels,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(WIDTH * 4),
                    rows_per_image: Some(HEIGHT),
                },
                size,
            );
            let mask = |center, size| MaskUniforms {
                rect_center: center,
                rect_size: size,
                feather: 0.01,
                opacity: 1.0,
                effect_size: 12.0,
                output_size: [WIDTH as f32, HEIGHT as f32],
                ..Default::default()
            };
            let cases = [
                ("Small", vec![mask([0.5, 0.5], [0.1, 0.1])]),
                ("Medium", vec![mask([0.5, 0.5], [0.5, 0.5])]),
                (
                    "Overlapping",
                    vec![
                        mask([0.47, 0.5], [0.28, 0.3]),
                        mask([0.57, 0.55], [0.26, 0.24]),
                    ],
                ),
                ("Edge-clipped", vec![mask([0.02, 0.04], [0.1, 0.12])]),
                ("Fullscreen", vec![mask([0.5, 0.5], [1.0, 1.0])]),
            ];
            println!(
                "Adapter: {}, {:?}, {:?}; {}x{}; {SAMPLES} samples; batch {BATCH}; radius 12",
                info.name, info.backend, info.device_type, WIDTH, HEIGHT
            );
            println!(
                "Submission-to-GPU-completion time per mask sequence; not GPU-only timestamps."
            );
            println!("| Mask | Fullscreen ms | Scissored ms | Speedup |");
            println!("| --- | ---: | ---: | ---: |");
            for (name, masks) in cases {
                let passes = masks
                    .iter()
                    .map(|mask| {
                        std::array::from_fn(|axis| {
                            let uniforms = MaskUniforms {
                                mode: if axis == 0 {
                                    BLUR_HORIZONTAL_MODE
                                } else {
                                    BLUR_VERTICAL_MODE
                                },
                                ..*mask
                            };
                            let buffer =
                                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                    label: None,
                                    contents: bytemuck::bytes_of(&uniforms),
                                    usage: wgpu::BufferUsages::UNIFORM,
                                });
                            BlurPass {
                                uniforms,
                                bind_group: layer.pipeline.bind_group(
                                    &device,
                                    &buffer,
                                    &views[axis],
                                    &layer.sampler,
                                ),
                            }
                        })
                    })
                    .collect::<Vec<_>>();
                let run = |scissored| measure(&device, &queue, &layer, &views, &passes, scissored);
                for _ in 0..3 {
                    run(false);
                    run(true);
                }
                let mut samples = [Vec::new(), Vec::new()];
                for sample in 0..SAMPLES {
                    for variant in [sample % 2, 1 - sample % 2] {
                        samples[variant].push(run(variant == 1));
                    }
                }
                let [fullscreen, scissored] = samples.map(|mut times| {
                    times.sort_by(f64::total_cmp);
                    times[SAMPLES / 2]
                });
                println!(
                    "| {name} | {fullscreen:.2} | {scissored:.2} | {:.2}x |",
                    fullscreen / scissored
                );
            }
        }
    }
}
