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
const CURSOR_CLICK_DURATION_MS: f64 = CURSOR_CLICK_DURATION * 1000.0;
const CLICK_SHRINK_SIZE: f32 = 0.7;
const CURSOR_IDLE_MIN_DELAY_MS: f64 = 500.0;
const CURSOR_IDLE_FADE_OUT_MS: f64 = 400.0;
const CURSOR_VECTOR_CAP: f32 = 320.0;
const CURSOR_MIN_MOTION_NORMALIZED: f32 = 0.01;
const CURSOR_MIN_MOTION_PX: f32 = 1.0;
const CURSOR_BASELINE_FPS: f32 = 60.0;
const CURSOR_MULTIPLIER: f32 = 3.0;
const CURSOR_MAX_STRENGTH: f32 = 5.0;
const VELOCITY_BLEND_RATIO: f32 = 0.7;

/// The size to render the svg to.
static SVG_CURSOR_RASTERIZED_HEIGHT: u32 = 200;

const CIRCLE_CURSOR_SIZE: u32 = 256;

pub struct CursorLayer {
    statics: Statics,
    bind_group: Option<BindGroup>,
    cursors: HashMap<String, CursorTexture>,
    circle_cursor: Option<CursorTexture>,
    prev_is_svg_assets_enabled: Option<bool>,
    prev_cursor_type: Option<CursorType>,
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
            circle_cursor: None,
            prev_is_svg_assets_enabled: None,
            prev_cursor_type: None,
        }
    }

    fn create_circle_cursor(constants: &RenderVideoConstants) -> CursorTexture {
        let size = CIRCLE_CURSOR_SIZE;
        let mut rgba = vec![0u8; (size * size * 4) as usize];
        let center = size as f32 / 2.0;
        let outer_radius = center - size as f32 * 0.08;
        let border_width = size as f32 * 0.025;
        let edge_softness = size as f32 * 0.015;

        let fill_alpha = 0.2_f32;
        let border_alpha = 0.55_f32;

        for y in 0..size {
            for x in 0..size {
                let dx = x as f32 - center + 0.5;
                let dy = y as f32 - center + 0.5;
                let dist = (dx * dx + dy * dy).sqrt();
                let idx = ((y * size + x) * 4) as usize;

                if dist <= outer_radius + edge_softness {
                    let outer_fade = 1.0 - ((dist - outer_radius) / edge_softness).clamp(0.0, 1.0);

                    let border_start = outer_radius - border_width;
                    let border_factor = if dist >= border_start {
                        ((dist - border_start) / border_width).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };

                    let base_alpha = fill_alpha + border_factor * (border_alpha - fill_alpha);
                    let alpha = base_alpha * outer_fade;

                    let premul = (255.0 * alpha) as u8;
                    rgba[idx] = premul;
                    rgba[idx + 1] = premul;
                    rgba[idx + 2] = premul;
                    rgba[idx + 3] = premul;
                }
            }
        }

        CursorTexture::prepare(constants, &rgba, (size, size), XY::new(0.5, 0.5))
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

        let fps = uniforms.frame_rate.max(1) as f32;
        let screen_size = constants.options.screen_size;
        let screen_diag =
            (((screen_size.x as f32).powi(2) + (screen_size.y as f32).powi(2)).sqrt()).max(1.0);
        let fps_scale = fps / CURSOR_BASELINE_FPS;
        let cursor_strength = (uniforms.motion_blur_amount * CURSOR_MULTIPLIER * fps_scale)
            .clamp(0.0, CURSOR_MAX_STRENGTH);
        let parent_motion = uniforms.display_parent_motion_px;
        let child_motion = {
            let delta_motion = uniforms
                .prev_cursor
                .as_ref()
                .filter(|prev| prev.cursor_id == interpolated_cursor.cursor_id)
                .map(|prev| {
                    let delta_uv = XY::new(
                        (interpolated_cursor.position.coord.x - prev.position.coord.x) as f32,
                        (interpolated_cursor.position.coord.y - prev.position.coord.y) as f32,
                    );
                    XY::new(
                        delta_uv.x * screen_size.x as f32,
                        delta_uv.y * screen_size.y as f32,
                    )
                })
                .unwrap_or_else(|| XY::new(0.0, 0.0));

            let spring_velocity = XY::new(
                interpolated_cursor.velocity.x * screen_size.x as f32 / fps,
                interpolated_cursor.velocity.y * screen_size.y as f32 / fps,
            );

            XY::new(
                delta_motion.x * (1.0 - VELOCITY_BLEND_RATIO)
                    + spring_velocity.x * VELOCITY_BLEND_RATIO,
                delta_motion.y * (1.0 - VELOCITY_BLEND_RATIO)
                    + spring_velocity.y * VELOCITY_BLEND_RATIO,
            )
        };

        let combined_motion_px = if cursor_strength <= f32::EPSILON {
            XY::new(0.0, 0.0)
        } else {
            combine_cursor_motion(parent_motion, child_motion)
        };

        let normalized_motion = ((combined_motion_px.x / screen_diag).powi(2)
            + (combined_motion_px.y / screen_diag).powi(2))
        .sqrt();
        let has_motion =
            normalized_motion > CURSOR_MIN_MOTION_NORMALIZED && cursor_strength > f32::EPSILON;
        let scaled_motion = if has_motion {
            clamp_cursor_vector(combined_motion_px * cursor_strength)
        } else {
            XY::new(0.0, 0.0)
        };

        let mut cursor_opacity = 1.0f32;
        if uniforms.project.cursor.hide_when_idle && !cursor.moves.is_empty() {
            let hide_delay_secs = uniforms
                .project
                .cursor
                .hide_when_idle_delay
                .max((CURSOR_IDLE_MIN_DELAY_MS / 1000.0) as f32);
            let hide_delay_ms = (hide_delay_secs as f64 * 1000.0).max(CURSOR_IDLE_MIN_DELAY_MS);
            cursor_opacity = compute_cursor_idle_opacity(
                cursor,
                segment_frames.recording_time as f64 * 1000.0,
                hide_delay_ms,
            );
            if cursor_opacity <= f32::EPSILON {
                cursor_opacity = 0.0;
            }
        }

        let cursor_type = uniforms.project.cursor.cursor_type().clone();

        if self.prev_cursor_type.as_ref() != Some(&cursor_type) {
            self.prev_cursor_type = Some(cursor_type.clone());
            self.circle_cursor = None;
        }

        if self.prev_is_svg_assets_enabled != Some(uniforms.project.cursor.use_svg) {
            self.prev_is_svg_assets_enabled = Some(uniforms.project.cursor.use_svg);
            self.cursors.drain();
        }

        let cursor_texture = if cursor_type == CursorType::Circle {
            if self.circle_cursor.is_none() {
                self.circle_cursor = Some(Self::create_circle_cursor(constants));
            }
            self.circle_cursor.as_ref().unwrap()
        } else {
            if !self.cursors.contains_key(&interpolated_cursor.cursor_id) {
                let mut loaded_cursor = None;

                let cursor_shape = match &constants.recording_meta.inner {
                    RecordingMetaInner::Studio(studio) => match studio.as_ref() {
                        StudioRecordingMeta::MultipleSegments {
                            inner:
                                MultipleSegments {
                                    cursors: Cursors::Correct(cursors),
                                    ..
                                },
                        } => cursors
                            .get(&interpolated_cursor.cursor_id)
                            .and_then(|v| v.shape),
                        _ => None,
                    },
                    _ => None,
                };

                if let Some(cursor_shape) = cursor_shape
                    && uniforms.project.cursor.use_svg
                    && let Some(info) = cursor_shape.resolve()
                {
                    loaded_cursor =
                        CursorTexture::prepare_svg(constants, info.raw, info.hotspot.into())
                            .map_err(|err| {
                                error!(
                                    "Error loading SVG cursor {:?}: {err}",
                                    interpolated_cursor.cursor_id
                                )
                            })
                            .ok();
                }

                if let StudioRecordingMeta::MultipleSegments { inner, .. } = &constants.meta
                    && loaded_cursor.is_none()
                    && let Some(c) = inner
                        .get_cursor_image(&constants.recording_meta, &interpolated_cursor.cursor_id)
                    && let Ok(img) = image::open(&c.path).map_err(|err| {
                        error!("Failed to load cursor image from {:?}: {err}", c.path)
                    })
                {
                    loaded_cursor = Some(CursorTexture::prepare(
                        constants,
                        &img.to_rgba8(),
                        img.dimensions(),
                        c.hotspot,
                    ));
                }

                if let Some(c) = loaded_cursor {
                    self.cursors
                        .insert(interpolated_cursor.cursor_id.clone(), c);
                }
            }
            let Some(tex) = self.cursors.get(&interpolated_cursor.cursor_id) else {
                error!("Cursor {:?} not found!", interpolated_cursor.cursor_id);
                return;
            };
            tex
        };

        let size = {
            let base_size_px = STANDARD_CURSOR_HEIGHT / constants.options.screen_size.y as f32
                * uniforms.output_size.1 as f32;

            let cursor_size_factor = if uniforms.cursor_size <= 0.0 {
                100.0
            } else {
                uniforms.cursor_size / 100.0
            };

            // 0 -> 1 indicating how much to shrink from click
            let click_t = get_click_t(&cursor.clicks, (time_s as f64) * 1000.0);
            // lerp shrink size
            let click_scale_factor = click_t * 1.0 + (1.0 - click_t) * CLICK_SHRINK_SIZE;

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

        let effective_strength = if has_motion { cursor_strength } else { 0.0 };

        let cursor_uniforms = CursorUniforms {
            position_size: [
                zoomed_position.x as f32,
                zoomed_position.y as f32,
                zoomed_size.x as f32,
                zoomed_size.y as f32,
            ],
            output_size: [
                uniforms.output_size.0 as f32,
                uniforms.output_size.1 as f32,
                0.0,
                0.0,
            ],
            screen_bounds: uniforms.display.target_bounds,
            motion_vector_strength: [
                scaled_motion.x,
                scaled_motion.y,
                effective_strength,
                cursor_opacity,
            ],
            rotation_params: [
                uniforms.project.cursor.rotation_amount,
                uniforms.project.cursor.base_rotation,
                0.0,
                0.0,
            ],
        };

        constants.queue.write_buffer(
            &self.statics.uniform_buffer,
            0,
            bytemuck::cast_slice(&[cursor_uniforms]),
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

fn combine_cursor_motion(parent: XY<f32>, child: XY<f32>) -> XY<f32> {
    fn combine_axis(parent: f32, child: f32) -> f32 {
        if parent.abs() > CURSOR_MIN_MOTION_PX
            && child.abs() > CURSOR_MIN_MOTION_PX
            && parent.signum() != child.signum()
        {
            0.0
        } else {
            parent + child
        }
    }

    XY::new(
        combine_axis(parent.x, child.x),
        combine_axis(parent.y, child.y),
    )
}

fn clamp_cursor_vector(vec: XY<f32>) -> XY<f32> {
    let len = (vec.x * vec.x + vec.y * vec.y).sqrt();
    if len <= CURSOR_VECTOR_CAP || len <= f32::EPSILON {
        vec
    } else {
        vec * (CURSOR_VECTOR_CAP / len)
    }
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable, Default)]
pub struct CursorUniforms {
    position_size: [f32; 4],
    output_size: [f32; 4],
    screen_bounds: [f32; 4],
    motion_vector_strength: [f32; 4],
    rotation_params: [f32; 4],
}

fn compute_cursor_idle_opacity(
    cursor: &CursorEvents,
    current_time_ms: f64,
    hide_delay_ms: f64,
) -> f32 {
    if cursor.moves.is_empty() {
        return 0.0;
    }

    if current_time_ms <= cursor.moves[0].time_ms {
        return 1.0;
    }

    let Some(last_index) = cursor
        .moves
        .iter()
        .rposition(|event| event.time_ms <= current_time_ms)
    else {
        return 1.0;
    };

    let last_move = &cursor.moves[last_index];

    let time_since_move = (current_time_ms - last_move.time_ms).max(0.0);

    let mut opacity = compute_cursor_fade_in(cursor, current_time_ms, hide_delay_ms);

    let fade_out = if time_since_move <= hide_delay_ms {
        1.0
    } else {
        let delta = time_since_move - hide_delay_ms;
        let fade = 1.0 - smoothstep64(0.0, CURSOR_IDLE_FADE_OUT_MS, delta);
        fade.clamp(0.0, 1.0) as f32
    };

    opacity *= fade_out;
    opacity.clamp(0.0, 1.0)
}

fn smoothstep64(edge0: f64, edge1: f64, x: f64) -> f64 {
    if edge1 <= edge0 {
        return if x < edge0 { 0.0 } else { 1.0 };
    }

    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn compute_cursor_fade_in(cursor: &CursorEvents, current_time_ms: f64, hide_delay_ms: f64) -> f32 {
    let resume_time = cursor
        .moves
        .windows(2)
        .rev()
        .find(|pair| {
            let prev = &pair[0];
            let next = &pair[1];
            next.time_ms <= current_time_ms && next.time_ms - prev.time_ms > hide_delay_ms
        })
        .map(|pair| pair[1].time_ms);

    let Some(resume_time_ms) = resume_time else {
        return 1.0;
    };

    let time_since_resume = (current_time_ms - resume_time_ms).max(0.0);

    smoothstep64(0.0, CURSOR_IDLE_FADE_OUT_MS, time_since_resume) as f32
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

    if let Some(next) = clicks.get(prev_i + 1)
        && !prev.down
        && next.down
        && next.time_ms - time_ms <= CURSOR_CLICK_DURATION_MS
    {
        return smoothstep(
            0.0,
            CURSOR_CLICK_DURATION_MS as f32,
            (time_ms - next.time_ms).abs() as f32,
        );
    }

    1.0
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
            format: wgpu::TextureFormat::Rgba8Unorm,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn move_event(time_ms: f64, x: f64, y: f64) -> CursorMoveEvent {
        CursorMoveEvent {
            active_modifiers: vec![],
            cursor_id: "pointer".into(),
            time_ms,
            x,
            y,
        }
    }

    fn cursor_events(times: &[(f64, f64, f64)]) -> CursorEvents {
        CursorEvents {
            moves: times
                .iter()
                .map(|(time, x, y)| move_event(*time, *x, *y))
                .collect(),
            clicks: vec![],
            keyboard: vec![],
        }
    }

    #[test]
    fn opacity_stays_visible_with_recent_move() {
        let cursor = cursor_events(&[(0.0, 0.0, 0.0), (1500.0, 0.1, 0.1)]);

        let opacity = compute_cursor_idle_opacity(&cursor, 2000.0, 2000.0);

        assert_eq!(opacity, 1.0);
    }

    #[test]
    fn opacity_fades_once_past_delay() {
        let cursor = cursor_events(&[(0.0, 0.0, 0.0)]);

        let opacity = compute_cursor_idle_opacity(&cursor, 3000.0, 1000.0);

        assert_eq!(opacity, 0.0);
    }

    #[test]
    fn opacity_fades_in_after_long_inactivity() {
        let cursor = cursor_events(&[(0.0, 0.0, 0.0), (5000.0, 0.5, 0.5)]);

        let hide_delay_ms = 2000.0;

        let at_resume = compute_cursor_idle_opacity(&cursor, 5000.0, hide_delay_ms);
        assert_eq!(at_resume, 0.0);

        let halfway = compute_cursor_idle_opacity(
            &cursor,
            5000.0 + CURSOR_IDLE_FADE_OUT_MS / 2.0,
            hide_delay_ms,
        );
        assert!((halfway - 0.5).abs() < 0.05);

        let after_fade = compute_cursor_idle_opacity(
            &cursor,
            5000.0 + CURSOR_IDLE_FADE_OUT_MS * 2.0,
            hide_delay_ms,
        );
        assert_eq!(after_fade, 1.0);
    }
}
