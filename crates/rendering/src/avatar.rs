use bytemuck::{Pod, Zeroable};
pub use cap_face_tracking::FacePose;
use wgpu::util::DeviceExt;

const AVATAR_SIZE: u32 = 512;

#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
pub struct AvatarUniforms {
    pub head_rotation: [f32; 3],
    pub mouth_open: f32,
    pub left_eye_open: f32,
    pub right_eye_open: f32,
    pub breathing_phase: f32,
    pub bounce: f32,
    pub bg_color: [f32; 4],
    pub _padding: [f32; 2],
}

impl Default for AvatarUniforms {
    fn default() -> Self {
        Self {
            head_rotation: [0.0; 3],
            mouth_open: 0.0,
            left_eye_open: 1.0,
            right_eye_open: 1.0,
            breathing_phase: 0.0,
            bounce: 0.0,
            bg_color: [0.15, 0.15, 0.18, 1.0],
            _padding: [0.0; 2],
        }
    }
}

pub struct AvatarRenderer {
    pipeline: wgpu::RenderPipeline,
    uniforms_buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    target_texture: wgpu::Texture,
    target_view: wgpu::TextureView,
    readback_buffer: wgpu::Buffer,
    output_data: Vec<u8>,
    time: f64,
    blink_timer: f64,
    next_blink: f64,
}

impl AvatarRenderer {
    pub fn new(device: &wgpu::Device) -> Self {
        let shader_src = include_str!("shaders/avatar-clawd.wgsl");
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("avatar-clawd shader"),
            source: wgpu::ShaderSource::Wgsl(shader_src.into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("avatar bind group layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("avatar pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("avatar render pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &[],
                    zero_initialize_workgroup_memory: false,
                },
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &[],
                    zero_initialize_workgroup_memory: false,
                },
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: Some(wgpu::Face::Back),
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState {
                count: 1,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            multiview: None,
            cache: None,
        });

        let uniforms = AvatarUniforms::default();
        let uniforms_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("avatar uniforms buffer"),
            contents: bytemuck::cast_slice(&[uniforms]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("avatar bind group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniforms_buffer.as_entire_binding(),
            }],
        });

        let target_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("avatar target texture"),
            size: wgpu::Extent3d {
                width: AVATAR_SIZE,
                height: AVATAR_SIZE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });

        let target_view = target_texture.create_view(&Default::default());

        let buffer_size = (AVATAR_SIZE * AVATAR_SIZE * 4) as u64;
        let readback_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("avatar readback buffer"),
            size: buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let output_data = vec![0u8; (AVATAR_SIZE * AVATAR_SIZE * 4) as usize];

        Self {
            pipeline,
            uniforms_buffer,
            bind_group,
            target_texture,
            target_view,
            readback_buffer,
            output_data,
            time: 0.0,
            blink_timer: 0.0,
            next_blink: 3.5,
        }
    }

    pub fn size() -> u32 {
        AVATAR_SIZE
    }

    pub fn render(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        face_pose: &FacePose,
        dt: f64,
    ) {
        self.time += dt;
        self.blink_timer += dt;

        let idle_mode = face_pose.confidence < 0.3;

        let blink_progress = if self.blink_timer >= self.next_blink {
            let elapsed = self.blink_timer - self.next_blink;
            let blink_duration = 0.2;
            if elapsed >= blink_duration {
                self.blink_timer = 0.0;
                self.next_blink = 3.0 + 3.0 * ((self.time * 0.7).sin() * 0.5 + 0.5);
                1.0_f32
            } else {
                let t = (elapsed / blink_duration) as f32;
                let blink_curve = if t < 0.5 {
                    1.0 - (t * 2.0)
                } else {
                    (t - 0.5) * 2.0
                };
                blink_curve
            }
        } else {
            1.0_f32
        };

        let breathing_phase = (self.time * 1.5).sin() as f32;

        let (head_rotation, mouth_open, left_eye_open, right_eye_open, bounce) = if idle_mode {
            let sway_x = (self.time * 0.4).sin() as f32 * 0.05;
            let sway_y = (self.time * 0.3).sin() as f32 * 0.03;
            (
                [sway_y, sway_x, 0.0],
                0.0_f32,
                blink_progress,
                blink_progress,
                0.0_f32,
            )
        } else {
            let left_eye = face_pose.left_eye_open.min(blink_progress);
            let right_eye = face_pose.right_eye_open.min(blink_progress);

            let bounce_val = if face_pose.mouth_open > 0.2 {
                (self.time * 12.0).sin().abs() as f32 * face_pose.mouth_open
            } else {
                0.0
            };

            (
                [
                    face_pose.head_pitch,
                    face_pose.head_yaw,
                    face_pose.head_roll,
                ],
                face_pose.mouth_open,
                left_eye,
                right_eye,
                bounce_val,
            )
        };

        let uniforms = AvatarUniforms {
            head_rotation,
            mouth_open,
            left_eye_open,
            right_eye_open,
            breathing_phase,
            bounce,
            bg_color: [0.15, 0.15, 0.18, 1.0],
            _padding: [0.0; 2],
        };

        queue.write_buffer(&self.uniforms_buffer, 0, bytemuck::bytes_of(&uniforms));

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("avatar render encoder"),
        });

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("avatar render pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.target_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.0,
                            g: 0.0,
                            b: 0.0,
                            a: 0.0,
                        }),
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

        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.target_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &self.readback_buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(AVATAR_SIZE * 4),
                    rows_per_image: Some(AVATAR_SIZE),
                },
            },
            wgpu::Extent3d {
                width: AVATAR_SIZE,
                height: AVATAR_SIZE,
                depth_or_array_layers: 1,
            },
        );

        queue.submit(std::iter::once(encoder.finish()));

        let buffer_slice = self.readback_buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });

        if device.poll(wgpu::PollType::Wait).is_ok() && rx.recv().is_ok_and(|r| r.is_ok()) {
            let data = buffer_slice.get_mapped_range();
            self.output_data.copy_from_slice(&data);
            drop(data);
            self.readback_buffer.unmap();
        }
    }

    pub fn output_rgba(&self) -> &[u8] {
        &self.output_data
    }
}
