use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use cap_project::*;
use image::GenericImageView;
use tracing::error;
use wgpu::{BindGroup, FilterMode, include_wgsl, util::DeviceExt};

use crate::{
    Coord, DecodedSegmentFrames, FrameSpace, ProjectUniforms, RenderVideoConstants,
    STANDARD_CURSOR_HEIGHT, zoom::InterpolatedZoom,
};

const CURSOR_CLICK_DURATION: f64 = 0.25;
const CLICK_SHRINK_SIZE: f32 = 0.7;

/// The size to render the svg to.
static SVG_CURSOR_RASTERIZED_HEIGHT: u32 = 200;

pub struct CursorLayer {
    statics: Statics,
    bind_group: Option<BindGroup>,
    cursors: HashMap<String, CursorTexture>,
    prev_is_svg_assets_enabled: Option<bool>,
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
                    constants: &[],
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
            cursors: Default::default(),
            prev_is_svg_assets_enabled: None,
        }
    }

    pub fn prepare(
        &mut self,

        resolution_base: XY<u32>,
        zoom: &InterpolatedZoom,
        uniforms: &ProjectUniforms,
        constants: &RenderVideoConstants,
    ) {
        if uniforms.project.cursor.hide {
            self.bind_group = None;
            return;
        }

        let Some(interpolated_cursor) = &uniforms.interpolated_cursor else {
            return;
        };

        let velocity: [f32; 2] = [0.0, 0.0];
        // let velocity: [f32; 2] = [
        //     interpolated_cursor.velocity.x * 75.0,
        //     interpolated_cursor.velocity.y * 75.0,
        // ];

        let speed = (velocity[0] * velocity[0] + velocity[1] * velocity[1]).sqrt();
        let motion_blur_amount = (speed * 0.3).min(1.0) * 0.0; // uniforms.project.cursor.motion_blur;

        // Remove all cursor assets if the svg configuration changes.
        // it might change the texture.
        //
        // This would be better if it only invalidated the required assets but that would be more complicated.
        if self.prev_is_svg_assets_enabled != Some(uniforms.project.cursor.use_svg) {
            self.prev_is_svg_assets_enabled = Some(uniforms.project.cursor.use_svg);
            self.cursors.drain();
        }

        if !self.cursors.contains_key(&interpolated_cursor.cursor_id) {
            let mut cursor = None;

            let cursor_shape = match &constants.recording_meta.inner {
                RecordingMetaInner::Studio(StudioRecordingMeta::MultipleSegments {
                    inner:
                        MultipleSegments {
                            cursors: Cursors::Correct(cursors),
                            ..
                        },
                }) => cursors
                    .get(&interpolated_cursor.cursor_id)
                    .and_then(|v| v.shape),
                _ => None,
            };

            // Attempt to find and load a higher-quality SVG cursor included in Cap.
            // These are used instead of the OS provided cursor images when possible as the quality is better.
            if let Some(cursor_shape) = cursor_shape
                && uniforms.project.cursor.use_svg
                && let Some(info) = cursor_shape.resolve()
            {
                cursor = CursorTexture::prepare_svg(constants, info.raw, info.hotspot.into())
                    .map_err(|err| {
                        error!(
                            "Error loading SVG cursor {:?}: {err}",
                            interpolated_cursor.cursor_id
                        )
                    })
                    .ok();
            }

            // If not we attempt to load the low-quality image cursor
            if let StudioRecordingMeta::MultipleSegments { inner, .. } = &constants.meta
                && cursor.is_none()
                && let Some(c) = inner
                    .get_cursor_image(&constants.recording_meta, &interpolated_cursor.cursor_id)
                && let Ok(img) = image::open(&c.path)
                    .map_err(|err| error!("Failed to load cursor image from {:?}: {err}", c.path))
            {
                cursor = Some(CursorTexture::prepare(
                    constants,
                    &img.to_rgba8(),
                    img.dimensions(),
                    c.hotspot,
                ));
            }

            if let Some(cursor) = cursor {
                self.cursors
                    .insert(interpolated_cursor.cursor_id.clone(), cursor);
            }
        }
        let Some(cursor_texture) = self.cursors.get(&interpolated_cursor.cursor_id) else {
            error!("Cursor {:?} not found!", interpolated_cursor.cursor_id);
            return;
        };

        let size = {
            let base_size_px = STANDARD_CURSOR_HEIGHT / constants.options.screen_size.y as f32
                * uniforms.output_size.1 as f32;

            let cursor_size_factor = if uniforms.cursor_size <= 0.0 {
                100.0
            } else {
                uniforms.cursor_size / 100.0
            };

            // lerp shrink size
            let click_scale_factor =
                uniforms.click_t * 1.0 + (1.0 - uniforms.click_t) * CLICK_SHRINK_SIZE;

            let size = base_size_px * cursor_size_factor * click_scale_factor;

            let texture_size_aspect = {
                let texture_size = cursor_texture.texture.size();
                texture_size.width as f32 / texture_size.height as f32
            };

            Coord::<FrameSpace>::new(if texture_size_aspect > 1.0 {
                // Wide cursor: base sizing on width to prevent excessive width
                let width = size;
                let height = size / texture_size_aspect;
                XY::new(width, height).into()
            } else {
                // Tall or square cursor: base sizing on height (current behavior)
                XY::new(size * texture_size_aspect, size).into()
            })
        };

        let hotspot = Coord::<FrameSpace>::new(size.coord * cursor_texture.hotspot);

        // Calculate position without hotspot first
        let position = interpolated_cursor.position.to_frame_space(
            &constants.options,
            &uniforms.project,
            resolution_base,
        ) - hotspot;

        // Transform to zoomed space
        let zoomed_position = position.to_zoomed_frame_space(
            &constants.options,
            &uniforms.project,
            resolution_base,
            zoom,
        );

        let zoomed_size = (position + size).to_zoomed_frame_space(
            &constants.options,
            &uniforms.project,
            resolution_base,
            zoom,
        ) - zoomed_position;

        let uniforms = CursorUniforms {
            position: [zoomed_position.x as f32, zoomed_position.y as f32],
            size: [zoomed_size.x as f32, zoomed_size.y as f32],
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
                .create_bind_group(&constants.device, &cursor_texture.texture),
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

struct CursorTexture {
    texture: wgpu::Texture,
    hotspot: XY<f64>,
}

impl CursorTexture {
    /// Prepare a cursor texture on the GPU from RGBA data.
    fn prepare(
        constants: &RenderVideoConstants,
        rgba: &[u8],
        dimensions: (u32, u32),
        hotspot: XY<f64>,
    ) -> Self {
        let texture = constants.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Cursor Texture"),
            size: wgpu::Extent3d {
                width: dimensions.0,
                height: dimensions.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        constants.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * dimensions.0),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: dimensions.0,
                height: dimensions.1,
                depth_or_array_layers: 1,
            },
        );

        Self { texture, hotspot }
    }

    /// Prepare a cursor texture on the GPU from a raw SVG file
    fn prepare_svg(
        constants: &RenderVideoConstants,
        svg_data: &str,
        hotspot: XY<f64>,
    ) -> Result<Self, String> {
        let rtree = resvg::usvg::Tree::from_str(svg_data, &resvg::usvg::Options::default())
            .map_err(|e| format!("Failed to parse SVG: {e}"))?;

        // Although we could probably determine the size that the cursor is going to be render,
        // that would depend on the cursor size the user selects.
        //
        // This would require reinitializing the texture every time that changes which would be more complicated.
        // So we trade a small about VRAM for only initializing it once.
        let aspect_ratio = rtree.size().width() / rtree.size().height();
        let width = (aspect_ratio * SVG_CURSOR_RASTERIZED_HEIGHT as f32) as u32;

        let mut pixmap = tiny_skia::Pixmap::new(width, SVG_CURSOR_RASTERIZED_HEIGHT)
            .ok_or("Failed to create pixmap")?;

        // Calculate scale to fit the SVG into the target size while maintaining aspect ratio
        let scale_x = width as f32 / rtree.size().width();
        let scale_y = SVG_CURSOR_RASTERIZED_HEIGHT as f32 / rtree.size().height();
        let scale = scale_x.min(scale_y);
        let transform = tiny_skia::Transform::from_scale(scale, scale);

        resvg::render(&rtree, transform, &mut pixmap.as_mut());

        let rgba: Vec<u8> = pixmap
            .pixels()
            .iter()
            .flat_map(|p| [p.red(), p.green(), p.blue(), p.alpha()])
            .collect();

        Ok(Self::prepare(
            constants,
            &rgba,
            (pixmap.width(), pixmap.height()),
            hotspot,
        ))
    }
}
