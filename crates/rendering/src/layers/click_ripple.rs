use bytemuck::{Pod, Zeroable};
use cap_project::XY;
use wgpu::{include_wgsl, util::DeviceExt};

use super::cursor::{CursorPlacement, cursor_height_px};
use crate::{Coord, FrameSpace, ProjectUniforms, RenderVideoConstants, zoom::InterpolatedZoom};

/// Ripples older than this are dropped rather than queued, so a burst of
/// clicks can never grow the uniform buffer.
pub const MAX_CLICK_RIPPLES: usize = 6;

/// Ring radius relative to the un-shrunk cursor height.
const RIPPLE_RADIUS_SCALE: f32 = 1.25;

/// Quad half-extent in ring radii. The ring's outer feather reaches
/// `r + w` = 1.16 radii at the end of the animation, so a quad of exactly
/// `2R` clips the last frames of the expansion into a squircle.
const RIPPLE_QUAD_EXTENT: f32 = 1.3;

/// Dynamic-offset slots must be `min_uniform_buffer_offset_alignment` apart;
/// 256 is the widest alignment any backend asks for.
const SLOT_SIZE: u64 = 256;

pub struct ClickRippleLayer {
    statics: Statics,
    bind_group: wgpu::BindGroup,
    instance_count: u32,
}

struct Statics {
    uniform_buffer: wgpu::Buffer,
    bind_group_layout: wgpu::BindGroupLayout,
    render_pipeline: wgpu::RenderPipeline,
}

impl Statics {
    fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Click Ripple Bind Group Layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: wgpu::BufferSize::new(
                        std::mem::size_of::<ClickRippleUniforms>() as u64,
                    ),
                },
                count: None,
            }],
        });

        let shader = device.create_shader_module(include_wgsl!("../shaders/click-ripple.wgsl"));

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Click Ripple Pipeline"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("Click Ripple Pipeline Layout"),
                    bind_group_layouts: &[&bind_group_layout],
                    push_constant_ranges: &[],
                }),
            ),
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
                    format: wgpu::TextureFormat::Rgba8Unorm,
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
                    constants: &[],
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
                label: Some("Click Ripple Uniform Buffer"),
                contents: &[0u8; MAX_CLICK_RIPPLES * SLOT_SIZE as usize],
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
        }
    }
}

impl ClickRippleLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        let statics = Statics::new(device);
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &statics.bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &statics.uniform_buffer,
                    offset: 0,
                    size: wgpu::BufferSize::new(std::mem::size_of::<ClickRippleUniforms>() as u64),
                }),
            }],
            label: Some("Click Ripple Bind Group"),
        });

        Self {
            statics,
            bind_group,
            instance_count: 0,
        }
    }

    pub fn prepare(
        &mut self,
        uniforms: &ProjectUniforms,
        resolution_base: XY<u32>,
        zoom: &InterpolatedZoom,
        constants: &RenderVideoConstants,
    ) {
        self.instance_count = 0;

        if uniforms.click_ripples.is_empty() {
            return;
        }

        let ripple = &uniforms.project.cursor.ripple;
        let color = [
            ripple.color[0] as f32 / 255.0,
            ripple.color[1] as f32 / 255.0,
            ripple.color[2] as f32 / 255.0,
            ripple.strength_clamped(),
        ];

        let crop = ProjectUniforms::get_crop(&constants.options, &uniforms.project);
        let display_size =
            ProjectUniforms::display_size(&constants.options, &uniforms.project, resolution_base);
        let radius = cursor_height_px(
            constants.options.screen_size.y as f32,
            crop.size.y as f32,
            display_size.y as f32,
            uniforms.cursor_size,
            1.0,
        ) * RIPPLE_RADIUS_SCALE
            * ripple.size_clamped();

        if !radius.is_finite() || radius <= 0.0 {
            return;
        }

        let quad_side = (radius * 2.0 * RIPPLE_QUAD_EXTENT) as f64;
        let size = Coord::<FrameSpace>::new(XY::new(quad_side, quad_side));
        let hotspot = XY::new(0.5, 0.5);
        let placement = CursorPlacement {
            constants,
            uniforms,
            resolution_base,
            zoom,
        };

        let mut slots = [0u8; MAX_CLICK_RIPPLES * SLOT_SIZE as usize];
        let mut count = 0usize;

        for click_ripple in uniforms.click_ripples.iter().take(MAX_CLICK_RIPPLES) {
            let position_uv = click_ripple.position.coord;
            if !position_uv.x.is_finite() || !position_uv.y.is_finite() {
                continue;
            }

            let (position_size, opacity) = placement.map(position_uv, size, hotspot, 1.0);
            if !position_size.iter().all(|v| v.is_finite()) {
                continue;
            }

            let slot = ClickRippleUniforms {
                position_size,
                output_size: [
                    uniforms.output_size.0 as f32,
                    uniforms.output_size.1 as f32,
                    0.0,
                    0.0,
                ],
                screen_bounds: uniforms.display.target_bounds,
                color,
                params: [
                    click_ripple.progress.clamp(0.0, 1.0),
                    opacity,
                    RIPPLE_QUAD_EXTENT,
                    0.0,
                ],
            };

            let offset = count * SLOT_SIZE as usize;
            slots[offset..offset + std::mem::size_of::<ClickRippleUniforms>()]
                .copy_from_slice(bytemuck::bytes_of(&slot));
            count += 1;
        }

        if count == 0 {
            return;
        }

        constants.queue.write_buffer(
            &self.statics.uniform_buffer,
            0,
            &slots[..count * SLOT_SIZE as usize],
        );
        self.instance_count = count as u32;
    }

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if self.instance_count == 0 {
            return;
        }

        pass.set_pipeline(&self.statics.render_pipeline);
        for i in 0..self.instance_count {
            pass.set_bind_group(0, &self.bind_group, &[i * SLOT_SIZE as u32]);
            pass.draw(0..4, 0..1);
        }
    }
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable, Default)]
struct ClickRippleUniforms {
    position_size: [f32; 4],
    output_size: [f32; 4],
    screen_bounds: [f32; 4],
    color: [f32; 4],
    params: [f32; 4],
}
