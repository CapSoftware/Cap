use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use cap_project::*;
use wgpu::{include_wgsl, util::DeviceExt};

use crate::{
    frame_pipeline::{FramePipeline, FramePipelineState},
    zoom::InterpolatedZoom,
    Coord, DecodedSegmentFrames, ProjectUniforms, RawDisplayUVSpace, STANDARD_CURSOR_HEIGHT,
};

pub struct CursorLayer;

impl CursorLayer {
    pub fn render(
        pipeline: &mut FramePipeline,
        segment_frames: &DecodedSegmentFrames,
        resolution_base: XY<u32>,
        cursor: &CursorEvents,
        zoom: &InterpolatedZoom,
    ) {
        let FramePipelineState {
            uniforms,
            constants,
            ..
        } = &pipeline.state;
        let segment_time = segment_frames.segment_time;

        let Some(cursor_position) = interpolate_cursor_position(
            cursor,
            segment_time,
            &uniforms.project.cursor.animation_style,
        ) else {
            return;
        };

        // Calculate previous position for velocity
        // let prev_position = interpolate_cursor_position(
        //     cursor,
        //     segment_time - 1.0 / 30.0,
        //     &uniforms.project.cursor.animation_style,
        // );

        // Calculate velocity in screen space
        let velocity: [f32; 2] = [0.0, 0.0];
        // if let Some(prev_pos) = prev_position {
        //     let curr_frame_pos =
        //         cursor_position.to_frame_space(&constants.options, &uniforms.project, resolution_base);
        //     let prev_frame_pos =
        //         prev_pos.to_frame_space(&constants.options, &uniforms.project, resolution_base);
        //     let frame_velocity = curr_frame_pos.coord - prev_frame_pos.coord;

        //     // Convert to pixels per frame
        //     [frame_velocity.x as f32, frame_velocity.y as f32]
        // } else {
        //     [0.0, 0.0]
        // };

        // Calculate motion blur amount based on velocity magnitude
        let speed = (velocity[0] * velocity[0] + velocity[1] * velocity[1]).sqrt();
        let motion_blur_amount =
            (speed * 0.3).min(1.0) * uniforms.project.motion_blur.unwrap_or(0.8);

        let cursor_event = find_cursor_event(&cursor, segment_time);

        let last_click_time = cursor
            .clicks
            .iter()
            .filter(|click| click.down && click.process_time_ms <= (segment_time as f64) * 1000.0)
            .max_by_key(|click| click.process_time_ms as i64)
            .map(|click| ((segment_time as f64) * 1000.0 - click.process_time_ms) as f32 / 1000.0)
            .unwrap_or(1.0);

        let Some(cursor_texture) = constants.cursor_textures.get(&cursor_event.cursor_id) else {
            return;
        };

        let cursor_size = cursor_texture.size();
        let aspect_ratio = cursor_size.width as f32 / cursor_size.height as f32;

        let cursor_size_percentage = if uniforms.cursor_size <= 0.0 {
            100.0
        } else {
            uniforms.cursor_size / 100.0
        };

        let normalized_size = [
            STANDARD_CURSOR_HEIGHT * aspect_ratio * cursor_size_percentage,
            STANDARD_CURSOR_HEIGHT * cursor_size_percentage,
        ];

        let position = cursor_position
            .to_frame_space(&constants.options, &uniforms.project, resolution_base)
            .to_zoomed_frame_space(&constants.options, &uniforms.project, resolution_base, zoom);
        let relative_position = [position.x as f32, position.y as f32];

        fn smoothstep(low: f32, high: f32, v: f32) -> f32 {
            let t = f32::clamp((v - low) / (high - low), 0.0, 1.0);
            t * t * (3.0 - 2.0 * t)
        }

        let click_scale = 1.0
            - (0.2
                * smoothstep(0.0, 0.25, last_click_time)
                * (1.0 - smoothstep(0.25, 0.5, last_click_time)));

        let output_size = ProjectUniforms::get_output_size(
            &constants.options,
            &uniforms.project,
            resolution_base,
        );
        let display_size =
            ProjectUniforms::display_size(&constants.options, &uniforms.project, resolution_base);

        let cursor_uniforms = CursorUniforms {
            position: [relative_position[0], relative_position[1], 0.0, 0.0],
            size: [normalized_size[0], normalized_size[1], 0.0, 0.0],
            output_size: [
                uniforms.output_size.0 as f32,
                uniforms.output_size.1 as f32,
                0.0,
                0.0,
            ],
            screen_bounds: uniforms.display.target_bounds,
            cursor_size: cursor_size_percentage
                * click_scale
                * zoom.display_amount() as f32
                * (display_size.coord.x as f32 / output_size.0 as f32),
            last_click_time,
            velocity,
            motion_blur_amount,
            _alignment: [0.0; 7],
        };

        let cursor_uniform_buffer =
            constants
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Cursor Uniform Buffer"),
                    contents: bytemuck::cast_slice(&[cursor_uniforms]),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

        let cursor_bind_group = constants
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                layout: &constants.cursor_pipeline.bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: cursor_uniform_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(
                            &cursor_texture.create_view(&wgpu::TextureViewDescriptor::default()),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(
                            &constants
                                .device
                                .create_sampler(&wgpu::SamplerDescriptor::default()),
                        ),
                    },
                ],
                label: Some("Cursor Bind Group"),
            });

        pipeline.encoder.do_render_pass(
            pipeline.state.get_current_texture_view(),
            &constants.cursor_pipeline.render_pipeline,
            cursor_bind_group,
            wgpu::LoadOp::Load,
        );
    }
}

pub struct CursorPipeline {
    bind_group_layout: wgpu::BindGroupLayout,
    render_pipeline: wgpu::RenderPipeline,
}

#[repr(C, align(16))]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct CursorUniforms {
    position: [f32; 4],
    size: [f32; 4],
    output_size: [f32; 4],
    screen_bounds: [f32; 4],
    cursor_size: f32,
    last_click_time: f32,
    velocity: [f32; 2],
    motion_blur_amount: f32,
    _alignment: [f32; 7],
}

pub fn find_cursor_event(cursor: &CursorEvents, time: f32) -> &CursorMoveEvent {
    let time_ms = time * 1000.0;

    if cursor.moves[0].process_time_ms > time_ms.into() {
        return &cursor.moves[0];
    }

    let event = cursor
        .moves
        .iter()
        .rev()
        .find(|event| {
            // println!("Checking event at time: {}ms", event.process_time_ms);
            event.process_time_ms <= time_ms.into()
        })
        .unwrap_or(&cursor.moves[0]);

    event
}

impl CursorPipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Cursor Pipeline Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: Some(std::num::NonZeroU64::new(112).unwrap()),
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
        }
    }
}

fn interpolate_cursor_position(
    cursor: &CursorEvents,
    time_secs: f32,
    animation_style: &CursorAnimationStyle,
) -> Option<Coord<RawDisplayUVSpace>> {
    let time_ms = (time_secs * 1000.0) as f64;

    if cursor.moves.is_empty() {
        return None;
    }

    if cursor.moves[0].process_time_ms > time_ms.into() {
        let event = &cursor.moves[0];

        return Some(Coord::new(XY {
            x: event.x,
            y: event.y,
        }));
    }

    if let Some(event) = cursor.moves.last() {
        if event.process_time_ms < time_ms.into() {
            return Some(Coord::new(XY {
                x: event.x,
                y: event.y,
            }));
        }
    }

    let Some(event) = cursor.moves.windows(2).find_map(|chunk| {
        if time_ms >= chunk[0].process_time_ms && time_ms < chunk[1].process_time_ms {
            Some(&chunk[0])
        } else {
            None
        }
    }) else {
        return None;
    };

    Some(Coord::new(XY {
        x: event.x,
        y: event.y,
    }))
}
