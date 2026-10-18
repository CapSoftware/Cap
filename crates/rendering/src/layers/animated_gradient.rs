use bytemuck::{Pod, Zeroable};
use cap_project::AnimatedGradientConfig;
use wgpu::util::DeviceExt;

use crate::ProjectUniforms;

const MAX_SURFACE_DIMENSION: u32 = 1280;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
struct AnimatedGradientUniforms {
    stops: [[f32; 4]; 5],
    flow: [f32; 4],
    lighting: [f32; 4],
    texture: [f32; 4],
    motion: [f32; 4],
    output: [f32; 4],
}

impl AnimatedGradientUniforms {
    fn new(config: &AnimatedGradientConfig, output: (u32, u32), seconds: f64) -> Self {
        let mut stops = [[0.0; 4]; 5];
        for (output, stop) in stops.iter_mut().zip(&config.color_stops) {
            *output = [
                stop.color[0] as f32 / 255.0,
                stop.color[1] as f32 / 255.0,
                stop.color[2] as f32 / 255.0,
                stop.position / 100.0,
            ];
        }
        Self {
            stops,
            flow: [
                config.direction.to_radians(),
                config.flow_scale,
                config.flow_strength / 100.0,
                config.curvature / 100.0,
            ],
            lighting: [
                config.relief / 100.0,
                config.light / 100.0,
                config.shade / 100.0,
                config.ripples * 0.03,
            ],
            texture: [
                config.grain_amount / 100.0,
                config.grain_size,
                config.exposure / 100.0,
                config.contrast / 100.0,
            ],
            motion: [
                (seconds * f64::from(config.motion_speed) / 50.0) as f32,
                config.vibrance / 100.0,
                (config.seed & 65535) as f32 / 1024.0,
                (config.seed >> 16) as f32 / 1024.0,
            ],
            output: [
                output.0 as f32,
                output.1 as f32,
                config.color_stops.len() as f32,
                config.detail,
            ],
        }
    }
}

pub struct AnimatedGradientLayer {
    config: AnimatedGradientConfig,
    motion_speed: f64,
    uniforms: AnimatedGradientUniforms,
    buffer: wgpu::Buffer,
    surface_pipeline: wgpu::RenderPipeline,
    surface_bind_group: wgpu::BindGroup,
    composite_pipeline: wgpu::RenderPipeline,
    composite_layout: wgpu::BindGroupLayout,
    composite_bind_group: wgpu::BindGroup,
    surface_view: wgpu::TextureView,
    surface_size: (u32, u32),
    sampler: wgpu::Sampler,
    surface_dirty: bool,
}

fn surface_size(output: (u32, u32)) -> (u32, u32) {
    let scale = (MAX_SURFACE_DIMENSION as f64 / output.0.max(output.1).max(1) as f64).min(1.0);
    (
        (output.0 as f64 * scale).round().max(1.0) as u32,
        (output.1 as f64 * scale).round().max(1.0) as u32,
    )
}

impl AnimatedGradientLayer {
    pub fn new(
        device: &wgpu::Device,
        config: AnimatedGradientConfig,
        project: &ProjectUniforms,
    ) -> Self {
        let normalized = config.normalized();
        let uniforms = AnimatedGradientUniforms::new(
            &normalized,
            project.output_size,
            f64::from(project.frame_number) / f64::from(project.frame_rate.max(1)),
        );
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Animated gradient uniforms"),
            contents: bytemuck::bytes_of(&uniforms),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let uniform_entry = wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let surface_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Animated gradient surface layout"),
            entries: &[uniform_entry],
        });
        let composite_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Animated gradient composite layout"),
            entries: &[
                uniform_entry,
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
        let shader =
            device.create_shader_module(wgpu::include_wgsl!("../shaders/animated-gradient.wgsl"));
        let pipeline = |layout: &wgpu::BindGroupLayout, entry, format| {
            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Animated gradient pipeline layout"),
                bind_group_layouts: &[layout],
                push_constant_ranges: &[],
            });
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(entry),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(entry),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview: None,
                cache: None,
            })
        };
        let surface_pipeline = pipeline(
            &surface_layout,
            "fs_surface",
            wgpu::TextureFormat::Rgba16Float,
        );
        let composite_pipeline = pipeline(
            &composite_layout,
            "fs_main",
            wgpu::TextureFormat::Rgba8Unorm,
        );
        let surface_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Animated gradient surface bind group"),
            layout: &surface_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: buffer.as_entire_binding(),
            }],
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Animated gradient sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let surface_size = surface_size(project.output_size);
        let surface_view = Self::surface_view(device, surface_size);
        let composite_bind_group =
            Self::composite_bind_group(device, &composite_layout, &buffer, &surface_view, &sampler);
        Self {
            config,
            motion_speed: f64::from(normalized.motion_speed) / 50.0,
            uniforms,
            buffer,
            surface_pipeline,
            surface_bind_group,
            composite_pipeline,
            composite_layout,
            composite_bind_group,
            surface_view,
            surface_size,
            sampler,
            surface_dirty: true,
        }
    }

    fn surface_view(device: &wgpu::Device, size: (u32, u32)) -> wgpu::TextureView {
        device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("Animated gradient surface"),
                size: wgpu::Extent3d {
                    width: size.0,
                    height: size.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
            .create_view(&Default::default())
    }

    fn composite_bind_group(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        buffer: &wgpu::Buffer,
        view: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Animated gradient composite bind group"),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        })
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        config: AnimatedGradientConfig,
        project: &ProjectUniforms,
    ) {
        let seconds = f64::from(project.frame_number) / f64::from(project.frame_rate.max(1));
        let mut uniforms = self.uniforms;
        if self.config != config {
            let normalized = config.normalized();
            uniforms = AnimatedGradientUniforms::new(&normalized, project.output_size, seconds);
            self.motion_speed = f64::from(normalized.motion_speed) / 50.0;
            self.config = config;
        }
        uniforms.motion[0] = (seconds * self.motion_speed) as f32;
        uniforms.output[0] = project.output_size.0 as f32;
        uniforms.output[1] = project.output_size.1 as f32;
        if uniforms != self.uniforms {
            queue.write_buffer(&self.buffer, 0, bytemuck::bytes_of(&uniforms));
            self.uniforms = uniforms;
            self.surface_dirty = true;
        }
        let size = surface_size(project.output_size);
        if self.surface_size != size {
            self.surface_view = Self::surface_view(device, size);
            self.composite_bind_group = Self::composite_bind_group(
                device,
                &self.composite_layout,
                &self.buffer,
                &self.surface_view,
                &self.sampler,
            );
            self.surface_size = size;
            self.surface_dirty = true;
        }
    }

    pub fn render_surface(&mut self, encoder: &mut wgpu::CommandEncoder) {
        if !self.surface_dirty {
            return;
        }
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Animated gradient surface pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.surface_view,
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
        pass.set_pipeline(&self.surface_pipeline);
        pass.set_bind_group(0, &self.surface_bind_group, &[]);
        pass.draw(0..3, 0..1);
        self.surface_dirty = false;
    }

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        pass.set_pipeline(&self.composite_pipeline);
        pass.set_bind_group(0, &self.composite_bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{
        BackgroundSource, CursorEvents, ProjectConfiguration, RecordingMeta, RecordingMetaInner,
        StudioRecordingMeta, XY,
    };

    use crate::{
        BackgroundLayer, DecodedSegmentFrames, RenderOptions, RenderVideoConstants,
        ZoomTransformTimeline,
        frame_pipeline::{RenderSession, finish_encoder, flush_pending_readback},
    };

    #[test]
    fn bounded_surface_preserves_aspect_and_small_outputs() {
        assert_eq!(surface_size((3840, 2160)), (1280, 720));
        assert_eq!(surface_size((2160, 3840)), (720, 1280));
        assert_eq!(surface_size((320, 180)), (320, 180));
        assert_eq!(surface_size((0, 0)), (1, 1));
    }

    #[test]
    fn motion_is_deterministic_and_zero_speed_freezes_it() {
        let mut config = AnimatedGradientConfig::default();
        let at = |config: &AnimatedGradientConfig, seconds| {
            AnimatedGradientUniforms::new(config, (1920, 1080), seconds)
        };
        assert_eq!(at(&config, 2.0), at(&config, 2.0));
        assert_ne!(at(&config, 2.0), at(&config, 3.0));
        config.motion_speed = 0.0;
        assert_eq!(at(&config, 0.0), at(&config, 7200.0));
        assert_eq!(std::mem::size_of::<AnimatedGradientUniforms>(), 160);
    }

    async fn test_constants() -> RenderVideoConstants {
        let meta: StudioRecordingMeta = serde_json::from_value(serde_json::json!({
            "display": { "path": "synthetic.mp4", "fps": 30 }
        }))
        .unwrap();
        let recording = RecordingMeta {
            platform: None,
            project_path: Default::default(),
            pretty_name: "Animated gradient test".into(),
            sharing: None,
            inner: RecordingMetaInner::Studio(Box::new(meta.clone())),
            upload: None,
        };
        RenderVideoConstants::new_with_options(
            RenderOptions {
                screen_size: XY::new(320, 180),
                camera_size: None,
                preserve_screen_alpha: false,
            },
            recording,
            meta,
        )
        .await
        .unwrap()
    }

    fn test_uniforms(constants: &RenderVideoConstants, frame: u32) -> ProjectUniforms {
        let project = ProjectConfiguration::default();
        let cursor = CursorEvents::default();
        let frames = DecodedSegmentFrames {
            screen_size: constants.options.screen_size,
            screen_frame: None,
            camera_frame: None,
            segment_time: frame as f32 / 30.0,
            recording_time: frame as f32 / 30.0,
            segment_has_camera: false,
        };
        let mut zoom = ZoomTransformTimeline::from_project(
            &project,
            &cursor,
            60.0,
            constants.options.screen_size,
        );
        zoom.ensure_precomputed_until(60.0);
        let mut uniforms = ProjectUniforms::new(
            constants,
            &project,
            frame,
            30,
            XY::new(320, 180),
            &cursor,
            &frames,
            60.0,
            &zoom,
        );
        uniforms.output_size = (320, 180);
        uniforms
    }

    async fn pixels(
        layer: &mut BackgroundLayer,
        constants: &RenderVideoConstants,
        config: &AnimatedGradientConfig,
        frame: u32,
    ) -> Vec<u8> {
        background_pixels(
            layer,
            constants,
            BackgroundSource::AnimatedGradient {
                config: config.clone(),
            },
            frame,
            30,
            (320, 180),
        )
        .await
    }

    async fn background_pixels(
        layer: &mut BackgroundLayer,
        constants: &RenderVideoConstants,
        source: BackgroundSource,
        frame: u32,
        frame_rate: u32,
        size: (u32, u32),
    ) -> Vec<u8> {
        let mut uniforms = test_uniforms(constants, frame);
        uniforms.frame_rate = frame_rate;
        uniforms.output_size = size;
        layer
            .prepare(constants, &uniforms, source.into())
            .await
            .unwrap();
        let mut session = RenderSession::new(&constants.device, size.0, size.1);
        let mut encoder = constants.device.create_command_encoder(&Default::default());
        layer.render_surface(&mut encoder);
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Animated gradient test"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: session.current_texture_view(),
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
            layer.render(&mut pass);
        }
        assert!(
            finish_encoder(
                &mut session,
                &constants.device,
                &constants.queue,
                &uniforms,
                encoder,
            )
            .await
            .unwrap()
            .is_none()
        );
        let frame = flush_pending_readback(&mut session, &constants.device)
            .await
            .unwrap()
            .unwrap();
        frame
            .data
            .chunks_exact(frame.padded_bytes_per_row as usize)
            .flat_map(|row| row[..size.0 as usize * 4].iter().copied())
            .collect()
    }

    #[tokio::test]
    #[ignore = "requires a graphics adapter"]
    async fn gpu_motion_seeking_freeze_and_color_stop_edges() {
        let constants = test_constants().await;
        let config = AnimatedGradientConfig::default();
        let mut layer = BackgroundLayer::new(&constants.device);
        let first = pixels(&mut layer, &constants, &config, 0).await;
        let later = pixels(&mut layer, &constants, &config, 900).await;
        assert_ne!(first, later);
        assert_eq!(first, pixels(&mut layer, &constants, &config, 0).await);
        if let Some(directory) = std::env::var_os("CAP_GRADIENT_TEST_OUTPUT") {
            std::fs::create_dir_all(&directory).unwrap();
            for (name, data) in [
                ("gradient-start.png", &first),
                ("gradient-later.png", &later),
            ] {
                image::RgbaImage::from_raw(320, 180, data.clone())
                    .unwrap()
                    .save(std::path::Path::new(&directory).join(name))
                    .unwrap();
            }
        }
        let frozen = AnimatedGradientConfig {
            motion_speed: 0.0,
            ..config
        };
        assert_eq!(
            pixels(&mut layer, &constants, &frozen, 0).await,
            pixels(&mut layer, &constants, &frozen, 900).await
        );
        let edges = AnimatedGradientConfig {
            color_stops: vec![
                cap_project::AnimatedGradientStop {
                    color: [255, 0, 0],
                    position: 25.0,
                },
                cap_project::AnimatedGradientStop {
                    color: [0, 0, 255],
                    position: 75.0,
                },
            ],
            direction: 0.0,
            flow_strength: 0.0,
            curvature: 0.0,
            relief: 0.0,
            light: 0.0,
            shade: 0.0,
            grain_amount: 0.0,
            ..frozen
        };
        let result = pixels(&mut layer, &constants, &edges, 0).await;
        assert_eq!(&result[..4], &[255, 0, 0, 255]);
        assert_eq!(&result[319 * 4..320 * 4], &[0, 0, 255, 255]);
        assert!(result.chunks_exact(4).all(|pixel| pixel[3] == 255));
    }

    #[tokio::test]
    #[ignore = "requires a graphics adapter"]
    async fn gpu_switching_backgrounds_resizing_and_frame_rate_parity() {
        let constants = test_constants().await;
        let mut layer = BackgroundLayer::new(&constants.device);
        let animated = BackgroundSource::AnimatedGradient {
            config: AnimatedGradientConfig::default(),
        };
        let legacy_sources = [
            BackgroundSource::Color {
                value: [33, 40, 66],
                alpha: 255,
            },
            BackgroundSource::Gradient {
                from: [31, 54, 190],
                to: [237, 116, 194],
                angle: 45,
                noise_intensity: None,
                noise_scale: None,
                animated: None,
                animation_speed: None,
            },
        ];
        for legacy in legacy_sources {
            let original =
                background_pixels(&mut layer, &constants, legacy.clone(), 0, 30, (320, 180)).await;
            let at_30fps =
                background_pixels(&mut layer, &constants, animated.clone(), 60, 30, (320, 180))
                    .await;
            let at_60fps = background_pixels(
                &mut layer,
                &constants,
                animated.clone(),
                120,
                60,
                (320, 180),
            )
            .await;
            assert_eq!(at_30fps, at_60fps);
            assert_ne!(original, at_30fps);
            let resized =
                background_pixels(&mut layer, &constants, animated.clone(), 60, 30, (180, 320))
                    .await;
            assert_eq!(resized.len(), 180 * 320 * 4);
            assert_eq!(
                at_30fps,
                background_pixels(&mut layer, &constants, animated.clone(), 60, 30, (320, 180))
                    .await
            );
            assert_eq!(
                original,
                background_pixels(&mut layer, &constants, legacy, 900, 30, (320, 180)).await
            );
        }
    }
}
