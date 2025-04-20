use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use cap_project::*;
use wgpu::{include_wgsl, util::DeviceExt, FilterMode};

use crate::{
    frame_pipeline::{FramePipeline, FramePipelineState},
    spring_mass_damper::{SpringMassDamperSimulation, SpringMassDamperSimulationConfig},
    zoom::InterpolatedZoom,
    Coord, DecodedSegmentFrames, ProjectUniforms, RawDisplayUVSpace, STANDARD_CURSOR_HEIGHT,
};

const CURSOR_CLICK_DURATION: f64 = 0.25;
const CURSOR_CLICK_DURATION_MS: f64 = CURSOR_CLICK_DURATION * 1000.0;
const CLICK_SHRINK_SIZE: f32 = 0.7;

pub struct CursorLayer {
    uniform_buffer: wgpu::Buffer,
    texture_sampler: wgpu::Sampler,
    bind_group_layout: wgpu::BindGroupLayout,
    render_pipeline: wgpu::RenderPipeline,
}

impl CursorLayer {
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
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &empty_constants,
                    zero_initialize_workgroup_memory: false,
                },
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
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

    pub fn render(
        &self,
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
        let time_s = segment_frames.recording_time;

        let cursor_settings = &uniforms.project.cursor;
        let Some(interpolated_cursor) = interpolate_cursor(
            cursor,
            time_s,
            (!cursor_settings.raw).then(|| SpringMassDamperSimulationConfig {
                tension: cursor_settings.tension,
                mass: cursor_settings.mass,
                friction: cursor_settings.friction,
            }),
        ) else {
            return;
        };

        let velocity: [f32; 2] = [0.0, 0.0];
        // let velocity: [f32; 2] = [
        //     interpolated_cursor.velocity.x * 75.0,
        //     interpolated_cursor.velocity.y * 75.0,
        // ];

        let speed = (velocity[0] * velocity[0] + velocity[1] * velocity[1]).sqrt();
        let motion_blur_amount = (speed * 0.3).min(1.0) * 0.0; // uniforms.project.cursor.motion_blur;
        let last_move_event = find_cursor_move(&cursor, time_s);

        let Some(cursor_texture) = constants.cursor_textures.get(&last_move_event.cursor_id) else {
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

        constants
            .queue
            .write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&[uniforms]));

        let cursor_bind_group = constants
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                layout: &self.bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: self.uniform_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(
                            &cursor_texture
                                .inner
                                .create_view(&wgpu::TextureViewDescriptor::default()),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&self.texture_sampler),
                    },
                ],
                label: Some("Cursor Bind Group"),
            });

        pipeline.encoder.do_render_pass(
            pipeline.state.get_current_texture_view(),
            &self.render_pipeline,
            cursor_bind_group,
            wgpu::LoadOp::Load,
        );
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

struct InterpolatedCursorPosition {
    position: Coord<RawDisplayUVSpace>,
    velocity: XY<f32>,
}

fn interpolate_cursor(
    cursor: &CursorEvents,
    time_secs: f32,
    smoothing: Option<SpringMassDamperSimulationConfig>,
) -> Option<InterpolatedCursorPosition> {
    let time_ms = (time_secs * 1000.0) as f64;

    if cursor.moves.is_empty() {
        return None;
    }

    if cursor.moves[0].time_ms > time_ms.into() {
        let event = &cursor.moves[0];

        return Some(InterpolatedCursorPosition {
            position: Coord::new(XY {
                x: event.x,
                y: event.y,
            }),
            velocity: XY::new(0.0, 0.0),
        });
    }

    if let Some(event) = cursor.moves.last() {
        if event.time_ms < time_ms.into() {
            return Some(InterpolatedCursorPosition {
                position: Coord::new(XY {
                    x: event.x,
                    y: event.y,
                }),
                velocity: XY::new(0.0, 0.0),
            });
        }
    }

    if let Some(smoothing_config) = smoothing {
        let events = get_smoothed_cursor_events(&cursor.moves, smoothing_config);
        interpolate_smoothed_position(&events, time_secs as f64, smoothing_config)
    } else {
        let pos = cursor.moves.windows(2).enumerate().find_map(|(i, chunk)| {
            if time_ms >= chunk[0].time_ms && time_ms < chunk[1].time_ms {
                let c = &chunk[0];
                Some(XY::new(c.x as f32, c.y as f32))
            } else {
                None
            }
        })?;

        Some(InterpolatedCursorPosition {
            position: Coord::new(XY {
                x: pos.x as f64,
                y: pos.y as f64,
            }),
            velocity: XY::new(0.0, 0.0),
        })
    }
}

fn interpolate_smoothed_position(
    smoothed_events: &[SmoothedCursorEvent],
    query_time: f64,
    smoothing_config: SpringMassDamperSimulationConfig,
) -> Option<InterpolatedCursorPosition> {
    if smoothed_events.is_empty() {
        return None;
    }

    let mut sim = SpringMassDamperSimulation::new(smoothing_config);

    let query_time_ms = (query_time * 1000.0) as f32;

    match smoothed_events
        .windows(2)
        .find(|chunk| chunk[0].time <= query_time_ms && query_time_ms < chunk[1].time)
    {
        Some(c) => {
            sim.set_position(c[0].position);
            sim.set_velocity(c[0].velocity);
            sim.set_target_position(c[0].target_position);
            sim.run(query_time_ms - c[0].time);
        }
        None => {
            let e = smoothed_events.last().unwrap();
            sim.set_position(e.position);
            sim.set_velocity(e.velocity);
            sim.set_target_position(e.target_position);
            sim.run(query_time_ms - e.time);
        }
    };

    Some(InterpolatedCursorPosition {
        position: Coord::new(sim.position.map(|v| v as f64)),
        velocity: sim.velocity,
    })
}

#[derive(Debug)]
struct SmoothedCursorEvent {
    time: f32,
    target_position: XY<f32>,
    position: XY<f32>,
    velocity: XY<f32>,
}

fn get_smoothed_cursor_events(
    moves: &[CursorMoveEvent],
    smoothing_config: SpringMassDamperSimulationConfig,
) -> Vec<SmoothedCursorEvent> {
    let mut last_time = 0.0;

    let mut events = vec![];

    let mut sim = SpringMassDamperSimulation::new(smoothing_config);

    sim.set_position(XY::new(moves[0].x, moves[0].y).map(|v| v as f32));
    sim.set_velocity(XY::new(0.0, 0.0));

    if moves[0].time_ms > 0.0 {
        events.push(SmoothedCursorEvent {
            time: 0.0,
            target_position: sim.position,
            position: sim.position,
            velocity: sim.velocity,
        })
    }

    for (i, m) in moves.iter().enumerate() {
        let target_position = moves
            .get(i + 1)
            .map(|e| XY::new(e.x, e.y).map(|v| v as f32))
            .unwrap_or(sim.target_position);
        sim.set_target_position(target_position);

        sim.run(m.time_ms as f32 - last_time);

        last_time = m.time_ms as f32;

        events.push(SmoothedCursorEvent {
            time: m.time_ms as f32,
            target_position,
            position: sim.position,
            velocity: sim.velocity,
        });
    }

    events
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
