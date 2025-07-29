use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use cap_project::*;
use image::GenericImageView;
use tracing::error;
use wgpu::{BindGroup, FilterMode, include_wgsl, util::DeviceExt};

use crate::{
    DecodedSegmentFrames, ProjectUniforms, RenderVideoConstants, STANDARD_CURSOR_HEIGHT,
    zoom::InterpolatedZoom,
};

const CURSOR_CLICK_DURATION: f64 = 0.25;
const CURSOR_CLICK_DURATION_MS: f64 = CURSOR_CLICK_DURATION * 1000.0;
const CLICK_SHRINK_SIZE: f32 = 0.7;

pub struct CursorLayer {
    statics: Statics,
    bind_group: Option<BindGroup>,
    cursors: HashMap<String, CursorTexture>,
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

        let velocity: [f32; 2] = [0.0, 0.0];
        // let velocity: [f32; 2] = [
        //     interpolated_cursor.velocity.x * 75.0,
        //     interpolated_cursor.velocity.y * 75.0,
        // ];

        let speed = (velocity[0] * velocity[0] + velocity[1] * velocity[1]).sqrt();
        let motion_blur_amount = (speed * 0.3).min(1.0) * 0.0; // uniforms.project.cursor.motion_blur;

        if !self.cursors.contains_key(&interpolated_cursor.cursor_id) {
            let mut cursor = None;
            // We first attempt to load a high-quality SVG cursor
            if !uniforms.project.cursor.raw && uniforms.project.cursor.use_svg {
                cursor = CursorTexture::get_svg(&constants, &interpolated_cursor.cursor_id)
                    .map_err(|err| {
                        error!(
                            "Error loading SVG cursor {:?}: {err}",
                            interpolated_cursor.cursor_id
                        )
                    })
                    .ok()
                    .flatten();
            }

            // If not we attempt to load the low-quality image cursor
            if let StudioRecordingMeta::MultipleSegments { inner, .. } = &constants.meta
                && cursor.is_none()
            {
                if let Some(c) = inner
                    .get_cursor_image(&constants.recording_meta, &interpolated_cursor.cursor_id)
                {
                    if let Ok(img) = image::open(&c.path).map_err(|err| {
                        error!("Failed to load cursor image from {:?}: {err}", c.path)
                    }) {
                        cursor = Some(CursorTexture::prepare(
                            constants,
                            &img.to_rgba8(),
                            img.dimensions(),
                            c.hotspot,
                        ));
                    }
                }
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

        let cursor_base_size_px = {
            let cursor_texture_size = cursor_texture.texture.size();
            let cursor_texture_size_aspect =
                cursor_texture_size.width as f32 / cursor_texture_size.height as f32;

            let screen_size = constants.options.screen_size;
            let cursor_size_percentage = if uniforms.cursor_size <= 0.0 {
                100.0
            } else {
                uniforms.cursor_size / 100.0
            };

            let factor =
                STANDARD_CURSOR_HEIGHT / screen_size.y as f32 * uniforms.output_size.1 as f32;

            XY::new(
                factor * cursor_texture_size_aspect * cursor_size_percentage,
                factor * cursor_size_percentage,
            )
        };

        let click_scale_factor = get_click_t(&cursor.clicks, (time_s as f64) * 1000.0)
            * (1.0 - CLICK_SHRINK_SIZE)
            + CLICK_SHRINK_SIZE;

        let cursor_size_px: XY<f64> =
            (cursor_base_size_px * click_scale_factor * zoom.display_amount() as f32).into();

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
            size: [cursor_size_px.x as f32, cursor_size_px.y as f32],
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

static CURSOR_ARROW: (&'static str, XY<f64>) = (
    include_str!("../../assets/cursors/arrow.svg"),
    XY::new(0.1, 0.1),
);

static CURSOR_IBEAM: (&'static str, XY<f64>) = (
    include_str!("../../assets/cursors/ibeam.svg"),
    XY::new(0.5, 0.5),
);
static CURSOR_CROSSHAIR: (&'static str, XY<f64>) = (
    include_str!("../../assets/cursors/crosshair.svg"),
    XY::new(0.5, 0.5),
);
static CURSOR_POINTING_HAND: (&'static str, XY<f64>) = (
    include_str!("../../assets/cursors/pointing-hand.svg"),
    XY::new(0.3, 0.1),
);
static CURSOR_RESIZE_NWSE: (&'static str, XY<f64>) = (
    include_str!("../../assets/cursors/resize-nwse.svg"),
    XY::new(0.5, 0.5),
);
static CURSOR_RESIZE_EW: (&'static str, XY<f64>) = (
    include_str!("../../assets/cursors/resize-ew.svg"),
    XY::new(0.5, 0.5),
);

struct CursorTexture {
    texture: wgpu::Texture,
    hotspot: XY<f64>,
}

impl CursorTexture {
    /// Attempt to find and load a higher-quality SVG cursor included in Cap.
    /// These are used instead of the OS provided cursor images when possible as the quality is better.
    fn get_svg(
        constants: &RenderVideoConstants,
        id: &str,
    ) -> Result<Option<CursorTexture>, String> {
        println!("GET SVG {:?} {:?}", id, constants.recording_meta.platform);

        Ok(match (id, &constants.recording_meta.platform) {
            (_, _) => Some(Self::prepare_svg(
                constants,
                CURSOR_RESIZE_NWSE.0,
                CURSOR_RESIZE_NWSE.1,
            )?),
            _ => None,
        })
    }

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
            &rgba,
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
        let size = 64; // TODO: Should scale with the cursor size in the editor

        let rtree = resvg::usvg::Tree::from_str(svg_data, &resvg::usvg::Options::default())
            .map_err(|e| format!("Failed to parse SVG: {}", e))?;

        let pixmap_size = rtree.size().to_int_size();
        let target_size = tiny_skia::IntSize::from_wh(size, size).ok_or("Invalid target size")?;

        let mut pixmap = tiny_skia::Pixmap::new(target_size.width(), target_size.height())
            .ok_or("Failed to create pixmap")?;

        // Calculate scale to fit the SVG into the target size while maintaining aspect ratio
        let scale_x = target_size.width() as f32 / pixmap_size.width() as f32;
        let scale_y = target_size.height() as f32 / pixmap_size.height() as f32;
        let scale = scale_x.min(scale_y);

        let transform = tiny_skia::Transform::from_scale(scale, scale);

        resvg::render(&rtree, transform, &mut pixmap.as_mut());

        let rgba: Vec<u8> = pixmap
            .pixels()
            .iter()
            .flat_map(|pixel| [pixel.red(), pixel.green(), pixel.red(), pixel.alpha()])
            .collect();

        Ok(Self::prepare(constants, &rgba, (size, size), hotspot))
    }
}
