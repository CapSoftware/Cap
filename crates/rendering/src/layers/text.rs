use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use cap_project::Color;
use glyphon::{Attrs, Buffer, Family, Metrics, Shaping, TextArea, TextBounds};
use serde::{Deserialize, Serialize};
use specta::Type;
use wgpu::{include_wgsl, util::DeviceExt, TextureFormat};

use crate::{frame_pipeline::FramePipeline, RenderingError};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Text {
    pub x: f32,
    pub y: f32,
    pub text_color: Option<[u8; 3]>,
    pub background_color: Option<Color>,
    pub background_opacity: Option<f32>,
    pub padding: Option<f32>,
    pub font_size: Option<f32>,
    pub line_height: Option<f32>,
    pub content: String,
}

pub struct TextLayer {}

impl TextLayer {
    pub fn render(pipeline: &mut FramePipeline) -> Result<(), RenderingError> {
        if let Some(text) = &pipeline.state.uniforms.caption_text {
            let frame_size = pipeline.state.constants.options.screen_size;

            {
                let state = &mut *pipeline.state.state;

                let mut buffer = Buffer::new(
                    &mut state.font_system,
                    Metrics::new(
                        text.font_size.unwrap_or(30.0),
                        text.line_height.unwrap_or(42.0),
                    ),
                );

                buffer.set_size(
                    &mut state.font_system,
                    Some(frame_size.x as f32),
                    Some(frame_size.y as f32),
                );
                buffer.set_text(
                    &mut state.font_system,
                    &text.content,
                    Attrs::new().family(Family::SansSerif),
                    Shaping::Advanced,
                );
                buffer.shape_until_scroll(&mut state.font_system, false);

                state.viewport.update(
                    &pipeline.state.constants.queue,
                    glyphon::Resolution {
                        width: frame_size.x,
                        height: frame_size.y,
                    },
                );

                let color = text.text_color.unwrap_or([255, 255, 255]);

                state.text_renderer.prepare(
                    &pipeline.state.constants.device,
                    &pipeline.state.constants.queue,
                    &mut state.font_system,
                    &mut state.atlas,
                    &state.viewport,
                    [TextArea {
                        buffer: &buffer,
                        left: text.x,
                        top: text.y,
                        scale: 1.0,
                        bounds: TextBounds {
                            left: 0,
                            top: 0,
                            right: frame_size.x as i32,
                            bottom: frame_size.y as i32,
                        },
                        default_color: glyphon::Color::rgb(color[0], color[1], color[2]),
                        custom_glyphs: &[],
                    }],
                    &mut state.swash_cache,
                )?;

                if let Some(bg_color) = text.background_color {
                    let opacity = text.background_opacity.unwrap_or(1.0);
                    let color = [
                        bg_color[0] as f32,
                        bg_color[1] as f32,
                        bg_color[2] as f32,
                        opacity,
                    ];

                    let text_rendered_size = measure(&buffer);
                    let padding = text.padding.unwrap_or(0.0);
                    let left = to_gpu_space(text.x - padding, frame_size.x as f32);
                    let right =
                        to_gpu_space(text.x + text_rendered_size.0 + padding, frame_size.x as f32);
                    let bottom = to_gpu_space(text.y - padding, frame_size.y as f32);
                    let top =
                        to_gpu_space(text.y + text_rendered_size.1 + padding, frame_size.y as f32);

                    pipeline
                        .state
                        .constants
                        .text_background_pipeline
                        .do_render_pass(
                            &pipeline.state.constants.device,
                            &mut pipeline.encoder.encoder,
                            pipeline.state.get_current_texture_view(),
                            &[
                                TextBackgroundUniforms {
                                    position: [left, bottom, 0.0],
                                    color,
                                },
                                TextBackgroundUniforms {
                                    position: [right, bottom, 0.0],
                                    color,
                                },
                                TextBackgroundUniforms {
                                    position: [right, top, 0.0],
                                    color,
                                },
                                TextBackgroundUniforms {
                                    position: [left, top, 0.0],
                                    color,
                                },
                            ],
                            // A square.
                            &[0, 1, 2, 2, 3, 0],
                        );
                }
            }

            let mut render_pass =
                pipeline
                    .encoder
                    .encoder
                    .begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: None,
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &pipeline.state.get_current_texture_view(),
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Load,
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });

            let state = &mut pipeline.state.state;
            state
                .text_renderer
                .render(&state.atlas, &state.viewport, &mut render_pass)?;
        }

        Ok(())
    }
}

fn measure(buffer: &glyphon::Buffer) -> (f32, f32) {
    let (width, total_lines) = buffer
        .layout_runs()
        .fold((0.0, 0usize), |(width, total_lines), run| {
            (run.line_w.max(width), total_lines + 1)
        });

    (width, total_lines as f32 * buffer.metrics().line_height)
}

pub struct TextBackgroundPipeline {
    pub render_pipeline: wgpu::RenderPipeline,
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct TextBackgroundUniforms {
    pub position: [f32; 3],
    pub color: [f32; 4],
}

impl TextBackgroundUniforms {
    fn to_buffer(self, device: &wgpu::Device) -> wgpu::Buffer {
        device.create_buffer_init(
            &(wgpu::util::BufferInitDescriptor {
                label: Some("TextBackgroundUniforms Buffer"),
                contents: bytemuck::cast_slice(&[self]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
        )
    }
}

impl TextBackgroundPipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let shader = device.create_shader_module(include_wgsl!("../shaders/text-background.wgsl"));

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("TextBackground Pipeline Layout"),
            bind_group_layouts: &[],
            push_constant_ranges: &[],
        });
        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("TextBackground Render Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<TextBackgroundUniforms>()
                        as wgpu::BufferAddress,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[
                        wgpu::VertexAttribute {
                            offset: 0,
                            shader_location: 0,
                            format: wgpu::VertexFormat::Float32x3,
                        },
                        wgpu::VertexAttribute {
                            offset: std::mem::size_of::<[f32; 3]>() as wgpu::BufferAddress,
                            shader_location: 1,
                            format: wgpu::VertexFormat::Float32x4,
                        },
                    ],
                }],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &mut HashMap::new(),
                    zero_initialize_workgroup_memory: false,
                },
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: TextureFormat::Rgba8UnormSrgb,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &mut HashMap::new(),
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
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Self { render_pipeline }
    }

    pub fn do_render_pass(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        output_view: &wgpu::TextureView,
        vertices: &[TextBackgroundUniforms],
        indices: &[u16],
    ) {
        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("TextBackground Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("TextBackground Index Buffer"),
            contents: bytemuck::cast_slice(indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("TextBackground Render Pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &output_view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });

        render_pass.set_pipeline(&self.render_pipeline);
        render_pass.set_vertex_buffer(0, vertex_buffer.slice(..));
        render_pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint16);
        render_pass.draw_indexed(0..indices.len() as u32, 0, 0..1);
    }
}

// Convert a pixel offset to GPU space (-1 to 1)
fn to_gpu_space(x: f32, total_width: f32) -> f32 {
    // Ensure total_width is not zero to avoid division by zero
    if total_width == 0.0 {
        panic!("Total width cannot be zero");
    }

    (2.0 * (x / total_width)) - 1.0
}
