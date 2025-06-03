use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use cap_project::*;
use wgpu::{include_wgsl, util::DeviceExt, BindGroup, FilterMode};

use crate::{
    zoom::InterpolatedZoom, DecodedSegmentFrames, ProjectUniforms, RenderVideoConstants,
    STANDARD_CURSOR_HEIGHT,
};

const CURSOR_CLICK_DURATION: f64 = 0.25;
const CURSOR_CLICK_DURATION_MS: f64 = CURSOR_CLICK_DURATION * 1000.0;
const CLICK_SHRINK_SIZE: f32 = 0.7;

pub struct CursorLayer {
    statics: Statics,
    bind_group: Option<BindGroup>,
}

struct Statics {
    uniform_buffer: wgpu::Buffer,
    texture_sampler: wgpu::Sampler,
    bind_group_layout: wgpu::BindGroupLayout,
    render_pipeline: wgpu::RenderPipeline,
}

impl Statics {
    fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Cursor Pipeline Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None, // Some(std::num::NonZeroU64::new(80).unwrap()),
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

        let shader = device.create_shader_module(include_wgsl!("../shaders/cursor.wgsl"));

        let empty_constants: HashMap<String, f64> = HashMap::new();

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Cursor Pipeline"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("Cursor Pipeline Layout"),
                    bind_group_layouts: &[&bind_group_layout],
                    push_constant_ranges: &[],
                }),
            ),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_main",
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &empty_constants,
                    zero_initialize_workgroup_memory: false,
                    vertex_pulling_transform: false,
                },
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_main",
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &empty_constants,
                    zero_initialize_workgroup_memory: false,
                    vertex_pulling_transform: false,
                },
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Self {
            bind_group_layout,
            render_pipeline,
            uniform_buffer: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Cursor Uniform Buffer"),
                contents: bytemuck::cast_slice(&[CursorUniforms::default()]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
            texture_sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                mag_filter: FilterMode::Linear,
                min_filter: FilterMode::Linear,
                mipmap_filter: FilterMode::Linear,
                anisotropy_clamp: 4,
                ..Default::default()
            }),
        }
    }

    fn create_bind_group(
        &self,
        device: &wgpu::Device,
        cursor_texture: &wgpu::Texture,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &cursor_texture.create_view(&wgpu::TextureViewDescriptor::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.texture_sampler),
                },
            ],
            label: Some("Cursor Bind Group"),
        })
    }
}

impl CursorLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        let statics = Statics::new(device);

        Self {
            statics,
            bind_group: None,
        }
    }

    pub fn prepare(
        &mut self,
        segment_frames: &DecodedSegmentFrames,
        resolution_base: XY<u32>,
        cursor: &CursorEvents,
        zoom: &InterpolatedZoom,
        uniforms: &ProjectUniforms,
        constants: &RenderVideoConstants,
    ) {
        if uniforms.project.cursor.hide {
            self.bind_group = None;
            return;
        }

        let time_s = segment_frames.recording_time;

        let Some(interpolated_cursor) = &uniforms.interpolated_cursor else {
            return;
        };

        // Calculate cursor velocity in pixels/second
        let velocity: [f32; 2] = [
            interpolated_cursor.velocity.x * 75.0,
            interpolated_cursor.velocity.y * 75.0,
        ];

        let speed = (velocity[0] * velocity[0] + velocity[1] * velocity[1]).sqrt();

        fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
            let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
            t * t * (3.0 - 2.0 * t)
        }

        let base_amount = uniforms.project.background.motion_blur;
        let speed_factor = smoothstep(0.0, 300.0, speed);
        let motion_blur_amount = base_amount * speed_factor;

        let Some(cursor_texture) = constants
            .cursor_textures
            .get(&interpolated_cursor.cursor_id)
        else {
            return;
        };

        let cursor_base_size_px = {
            let cursor_texture_size = cursor_texture.inner.size();
            let cursor_texture_size_aspect =
                cursor_texture_size.width as f32 / cursor_texture_size.height as f32;

            let cursor_size_percentage = if uniforms.cursor_size <= 0.0 {
                100.0
            } else {
                uniforms.cursor_size / 100.0
            };

            XY::new(
                STANDARD_CURSOR_HEIGHT * cursor_texture_size_aspect * cursor_size_percentage,
                STANDARD_CURSOR_HEIGHT * cursor_size_percentage,
            )
        };

        let click_scale_factor = get_click_t(&cursor.clicks, (time_s as f64) * 1000.0)
            * (1.0 - CLICK_SHRINK_SIZE)
            + CLICK_SHRINK_SIZE;

        let cursor_size_px =
            cursor_base_size_px * click_scale_factor * zoom.display_amount() as f32;

        let hotspot_px = cursor_texture.hotspot * cursor_size_px;

        let position = {
            let mut frame_position = interpolated_cursor.position.to_frame_space(
                &constants.options,
                &uniforms.project,
                resolution_base,
            );

            frame_position.coord = frame_position.coord - hotspot_px.map(|v| v as f64);

            frame_position
                .to_zoomed_frame_space(&constants.options, &uniforms.project, resolution_base, zoom)
                .coord
        };

        let uniforms = CursorUniforms {
            position: [position.x as f32, position.y as f32],
            size: [cursor_size_px.x, cursor_size_px.y],
            output_size: [uniforms.output_size.0 as f32, uniforms.output_size.1 as f32],
            screen_bounds: uniforms.display.target_bounds,
            velocity,
            motion_blur_amount,
            _alignment: [0.0; 3],
        };

        constants.queue.write_buffer(
            &self.statics.uniform_buffer,
            0,
            bytemuck::cast_slice(&[uniforms]),
        );

        self.bind_group = Some(
            self.statics
                .create_bind_group(&constants.device, &cursor_texture.inner),
        );
    }

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if let Some(bind_group) = &self.bind_group {
            pass.set_pipeline(&self.statics.render_pipeline);
            pass.set_bind_group(0, bind_group, &[]);
            pass.draw(0..4, 0..1);
        }
    }
}

#[repr(C, align(16))]
#[derive(Debug, Clone, Copy, Pod, Zeroable, Default)]
pub struct CursorUniforms {
    position: [f32; 2],
    size: [f32; 2],
    output_size: [f32; 2],
    screen_bounds: [f32; 4],
    velocity: [f32; 2],
    motion_blur_amount: f32,
    _alignment: [f32; 3],
}

pub fn find_cursor_move(cursor: &CursorEvents, time: f32) -> &CursorMoveEvent {
    let time_ms = time * 1000.0;

    if cursor.moves[0].time_ms > time_ms.into() {
        return &cursor.moves[0];
    }

    let event = cursor
        .moves
        .iter()
        .rev()
        .find(|event| {
            // println!("Checking event at time: {}ms", event.process_time_ms);
            event.time_ms <= time_ms.into()
        })
        .unwrap_or(&cursor.moves[0]);

    event
}

fn get_click_t(clicks: &[CursorClickEvent], time_ms: f64) -> f32 {
    fn smoothstep(low: f32, high: f32, v: f32) -> f32 {
        let t = f32::clamp((v - low) / (high - low), 0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    }

    let mut prev_i = None;

    for (i, clicks) in clicks.windows(2).enumerate() {
        let left = &clicks[0];
        let right = &clicks[1];

        if left.time_ms <= time_ms && right.time_ms > time_ms {
            prev_i = Some(i);
            break;
        }
    }

    let Some(prev_i) = prev_i else {
        return 1.0;
    };

    let prev = &clicks[prev_i];

    if prev.down {
        return 0.0;
    }

    if !prev.down && time_ms - prev.time_ms <= CURSOR_CLICK_DURATION_MS {
        return smoothstep(
            0.0,
            CURSOR_CLICK_DURATION_MS as f32,
            (time_ms - prev.time_ms) as f32,
        );
    }

    if let Some(next) = clicks.get(prev_i + 1) {
        if !prev.down && next.down && next.time_ms - time_ms <= CURSOR_CLICK_DURATION_MS {
            return smoothstep(
                0.0,
                CURSOR_CLICK_DURATION_MS as f32,
                (time_ms - next.time_ms).abs() as f32,
            );
        }
    }

    1.0
}
