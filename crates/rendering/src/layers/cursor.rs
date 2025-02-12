use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use cap_project::*;
use wgpu::{include_wgsl, util::DeviceExt};

use crate::{
    frame_pipeline::{FramePipeline, FramePipelineState},
    Coord, DecodedSegmentFrames, RawDisplayUVSpace, STANDARD_CURSOR_HEIGHT,
};

pub struct CursorLayer;

impl CursorLayer {
    pub fn render(
        pipeline: &mut FramePipeline,
        segment_frames: &DecodedSegmentFrames,
        resolution_base: XY<u32>,
    ) {
        let FramePipelineState {
            uniforms,
            constants,
            ..
        } = &pipeline.state;
        let segment_time = segment_frames.segment_time;

        let Some(cursor_position) = interpolate_cursor_position(
            &Default::default(), // constants.cursor,
            segment_time,
            &uniforms.project.cursor.animation_style,
        ) else {
            return;
        };

        // Calculate previous position for velocity
        let prev_position = interpolate_cursor_position(
            &Default::default(), // constants.cursor,
            segment_time - 1.0 / 30.0,
            &uniforms.project.cursor.animation_style,
        );

        // Calculate velocity in screen space
        let velocity = if let Some(prev_pos) = prev_position {
            let curr_frame_pos = cursor_position.to_frame_space(
                &constants.options,
                &uniforms.project,
                resolution_base,
            );
            let prev_frame_pos =
                prev_pos.to_frame_space(&constants.options, &uniforms.project, resolution_base);
            let frame_velocity = curr_frame_pos.coord - prev_frame_pos.coord;

            // Convert to pixels per frame
            [frame_velocity.x as f32, frame_velocity.y as f32]
        } else {
            [0.0, 0.0]
        };

        // Calculate motion blur amount based on velocity magnitude
        let speed = (velocity[0] * velocity[0] + velocity[1] * velocity[1]).sqrt();
        let motion_blur_amount =
            (speed * 0.3).min(1.0) * uniforms.project.motion_blur.unwrap_or(0.8);

        let cursor = Default::default();
        let cursor_event = find_cursor_event(&cursor /* constants.cursor */, segment_time);

        let last_click_time =  /* constants
            .cursor
            .clicks */ Vec::<CursorClickEvent>::new()
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

        let frame_position =
            cursor_position.to_frame_space(&constants.options, &uniforms.project, resolution_base);
        // let position = uniforms.zoom.apply_scale(frame_position);
        let position = frame_position;
        let relative_position = [position.x as f32, position.y as f32];

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
            cursor_size: cursor_size_percentage,
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

        pipeline.state.switch_output();
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

pub fn find_cursor_event(cursor: &CursorData, time: f32) -> &CursorMoveEvent {
    let time_ms = time * 1000.0;

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
    cursor: &CursorData,
    time_secs: f32,
    animation_style: &CursorAnimationStyle,
) -> Option<Coord<RawDisplayUVSpace>> {
    let time_ms = (time_secs * 1000.0) as f64;

    if cursor.moves.is_empty() {
        return None;
    }

    // Get style-specific parameters
    let (num_samples, velocity_threshold) = match animation_style {
        CursorAnimationStyle::Slow => (SLOW_SMOOTHING_SAMPLES, SLOW_VELOCITY_THRESHOLD),
        CursorAnimationStyle::Regular => (REGULAR_SMOOTHING_SAMPLES, REGULAR_VELOCITY_THRESHOLD),
        CursorAnimationStyle::Fast => (FAST_SMOOTHING_SAMPLES, FAST_VELOCITY_THRESHOLD),
    };

    // Find the closest move events around current time
    let mut closest_events: Vec<&CursorMoveEvent> = cursor
        .moves
        .iter()
        .filter(|m| (m.process_time_ms - time_ms).abs() <= 100.0) // Look at events within 100ms
        .collect();

    closest_events.sort_by(|a, b| {
        (a.process_time_ms - time_ms)
            .abs()
            .partial_cmp(&(b.process_time_ms - time_ms).abs())
            .unwrap()
    });

    // Take the nearest events up to num_samples
    let samples: Vec<(f64, f64, f64)> = closest_events
        .iter()
        .take(num_samples)
        .map(|m| (m.process_time_ms, m.x, m.y))
        .collect();

    if samples.is_empty() {
        // Fallback to nearest event if no samples in range
        let nearest = cursor
            .moves
            .iter()
            .min_by_key(|m| (m.process_time_ms - time_ms).abs() as i64)?;
        return Some(Coord::new(XY {
            x: nearest.x.clamp(0.0, 1.0),
            y: nearest.y.clamp(0.0, 1.0),
        }));
    }

    // Calculate velocities between consecutive points
    let mut velocities = Vec::with_capacity(samples.len() - 1);
    for i in 0..samples.len() - 1 {
        let (t1, x1, y1) = samples[i];
        let (t2, x2, y2) = samples[i + 1];
        let dt = (t2 - t1).max(1.0); // Avoid division by zero
        let dx = x2 - x1;
        let dy = y2 - y1;
        let velocity = ((dx * dx + dy * dy) / (dt * dt)).sqrt();
        velocities.push(velocity);
    }

    // Apply adaptive smoothing based on velocities and time distance
    let mut x = 0.0;
    let mut y = 0.0;
    let mut total_weight = 0.0;

    for (i, &(t, px, py)) in samples.iter().enumerate() {
        // Time-based weight with style-specific falloff
        let time_diff = (t - time_ms).abs();
        let style_factor = match animation_style {
            CursorAnimationStyle::Slow => 0.0005,
            CursorAnimationStyle::Regular => 0.001,
            CursorAnimationStyle::Fast => 0.002,
        };
        let time_weight = 1.0 / (1.0 + time_diff * style_factor);

        // Velocity-based weight
        let velocity_weight = if i < velocities.len() {
            let vel = velocities[i];
            if vel > velocity_threshold {
                (velocity_threshold / vel).powf(match animation_style {
                    CursorAnimationStyle::Slow => 1.5,
                    CursorAnimationStyle::Regular => 1.0,
                    CursorAnimationStyle::Fast => 0.5,
                })
            } else {
                1.0
            }
        } else {
            1.0
        };

        // Combine weights with style-specific emphasis
        let weight = match animation_style {
            CursorAnimationStyle::Slow => time_weight * velocity_weight.powf(1.5),
            CursorAnimationStyle::Regular => time_weight * velocity_weight,
            CursorAnimationStyle::Fast => time_weight * velocity_weight.powf(0.5),
        };

        x += px * weight;
        y += py * weight;
        total_weight += weight;
    }

    if total_weight > 0.0 {
        x /= total_weight;
        y /= total_weight;
    }

    Some(Coord::new(XY {
        x: x.clamp(0.0, 1.0),
        y: y.clamp(0.0, 1.0),
    }))
}
