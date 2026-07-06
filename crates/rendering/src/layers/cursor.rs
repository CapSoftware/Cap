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

const CURSOR_CLICK_DURATION: f64 = 0.13;
const CURSOR_CLICK_DURATION_MS: f64 = CURSOR_CLICK_DURATION * 1000.0;
const CLICK_SHRINK_SIZE: f32 = 0.8;
const CURSOR_IDLE_MIN_DELAY_MS: f64 = 500.0;
const CURSOR_IDLE_FADE_OUT_MS: f64 = 400.0;
const CURSOR_IDLE_RESUME_LOOKAHEAD_MS: f64 = 250.0;
/// Smear length ceiling in output px. Screen Studio semantics: the smear
/// length equals the cursor's per-frame travel scaled by the user amount —
/// linear, with no response curve — so this only bounds pathological
/// single-frame teleports, not real flicks (spring motion peaks well below
/// it at 60fps).
const CURSOR_VECTOR_CAP: f32 = 480.0;
const CURSOR_BASELINE_FPS: f32 = 60.0;
const CURSOR_MULTIPLIER: f32 = 1.0;
/// Upper bound on amount * (fps/60). Generous: it must not clip the fps
/// normalization at high frame rates (120fps needs 2x to keep the real-time
/// shutter constant).
const CURSOR_MAX_STRENGTH: f32 = 4.0;

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
    cursor_assets_preloaded: bool,
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
            cursor_assets_preloaded: false,
        }
    }

    fn create_circle_cursor(constants: &RenderVideoConstants) -> CursorTexture {
        let size = CIRCLE_CURSOR_SIZE;
        let mut rgba = vec![0u8; (size * size * 4) as usize];
        let center = size as f32 / 2.0;
        let outer_radius = center - size as f32 * 0.08;
        let dark_ring_width = size as f32 * 0.014;
        let light_ring_width = size as f32 * 0.016;
        let shadow_spread = size as f32 * 0.035;
        let edge_softness = size as f32 * 0.018;

        let inner_edge = outer_radius - dark_ring_width - light_ring_width;

        for y in 0..size {
            for x in 0..size {
                let dx = x as f32 - center + 0.5;
                let dy = y as f32 - center + 0.5;
                let dist = (dx * dx + dy * dy).sqrt();
                let idx = ((y * size + x) * 4) as usize;

                if dist > outer_radius + shadow_spread {
                    continue;
                }

                let mut color = [0.0_f32; 4];

                if dist > outer_radius {
                    let shadow_t = ((dist - outer_radius) / shadow_spread).clamp(0.0, 1.0);
                    let shadow_alpha = 0.16 * (1.0 - shadow_t * shadow_t);
                    composite_cursor_layer(&mut color, [0.0, 0.0, 0.0, shadow_alpha]);
                }

                if dist <= outer_radius + edge_softness {
                    let outer_fade = 1.0
                        - ((dist - outer_radius) / edge_softness)
                            .clamp(0.0, 1.0)
                            .powf(1.2);

                    if dist > outer_radius - dark_ring_width {
                        let ring_alpha = 0.38 * outer_fade;
                        composite_cursor_layer(&mut color, [0.0, 0.0, 0.0, ring_alpha]);
                    } else if dist > inner_edge {
                        let ring_alpha = 0.42 * outer_fade;
                        composite_cursor_layer(&mut color, [1.0, 1.0, 1.0, ring_alpha]);
                    } else {
                        let fill_alpha = 0.14 * outer_fade;
                        composite_cursor_layer(&mut color, [1.0, 1.0, 1.0, fill_alpha]);
                    }
                }

                if color[3] > 0.0 {
                    let a = color[3];
                    rgba[idx] = (color[0] * a * 255.0).round() as u8;
                    rgba[idx + 1] = (color[1] * a * 255.0).round() as u8;
                    rgba[idx + 2] = (color[2] * a * 255.0).round() as u8;
                    rgba[idx + 3] = (a * 255.0).round() as u8;
                }
            }
        }

        CursorTexture::prepare(constants, &rgba, (size, size), XY::new(0.5, 0.5))
    }

    fn load_cursor_texture(
        constants: &RenderVideoConstants,
        cursor_id: &str,
        use_svg: bool,
    ) -> Option<CursorTexture> {
        let mut loaded_cursor = None;

        let cursor_shape = match &constants.recording_meta.inner {
            RecordingMetaInner::Studio(studio) => match studio.as_ref() {
                StudioRecordingMeta::MultipleSegments {
                    inner:
                        MultipleSegments {
                            cursors: Cursors::Correct(cursors),
                            ..
                        },
                } => cursors.get(cursor_id).and_then(|v| v.shape),
                _ => None,
            },
            _ => None,
        };

        if let Some(cursor_shape) = cursor_shape
            && use_svg
            && let Some(info) = cursor_shape.resolve()
        {
            loaded_cursor = CursorTexture::prepare_svg(constants, info.raw, info.hotspot.into())
                .map_err(|err| error!("Error loading SVG cursor {cursor_id:?}: {err}"))
                .ok();
        }

        if let StudioRecordingMeta::MultipleSegments { inner, .. } = &constants.meta
            && loaded_cursor.is_none()
            && let Some(c) = inner.get_cursor_image(&constants.recording_meta, cursor_id)
            && let Ok(img) = image::open(&c.path)
                .map_err(|err| error!("Failed to load cursor image from {:?}: {err}", c.path))
        {
            loaded_cursor = Some(CursorTexture::prepare(
                constants,
                &img.to_rgba8(),
                img.dimensions(),
                c.hotspot,
            ));
        }

        loaded_cursor
    }

    fn preload_cursor_textures(&mut self, constants: &RenderVideoConstants, use_svg: bool) {
        let StudioRecordingMeta::MultipleSegments { inner, .. } = &constants.meta else {
            return;
        };

        let Cursors::Correct(cursors) = &inner.cursors else {
            return;
        };

        for cursor_id in cursors.keys() {
            if !self.cursors.contains_key(cursor_id)
                && let Some(texture) = Self::load_cursor_texture(constants, cursor_id, use_svg)
            {
                self.cursors.insert(cursor_id.clone(), texture);
            }
        }
    }

    pub(crate) fn preload_assets(
        &mut self,
        constants: &RenderVideoConstants,
        use_svg: bool,
        cursor_type: &CursorType,
    ) {
        self.prev_cursor_type = Some(cursor_type.clone());

        if cursor_type == &CursorType::Circle {
            if self.circle_cursor.is_none() {
                self.circle_cursor = Some(Self::create_circle_cursor(constants));
            }
            return;
        }

        self.prev_is_svg_assets_enabled = Some(use_svg);
        self.preload_cursor_textures(constants, use_svg);
        self.cursor_assets_preloaded = true;
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

        // Out-of-band positions (cursor in a cropped-away region, spring
        // overshoot past a display edge) still render: the shader's
        // screen_bounds clip confines the sprite to the display card, so it
        // slides off the card edge and back instead of popping in and out.
        // Only non-finite data hides it outright.
        let cursor_uv = &interpolated_cursor.position.coord;
        if !cursor_uv.x.is_finite() || !cursor_uv.y.is_finite() {
            self.bind_group = None;
            return;
        }

        let fps = uniforms.frame_rate.max(1) as f32;
        let screen_size = constants.options.screen_size;
        let fps_scale = fps / CURSOR_BASELINE_FPS;
        let cursor_strength = (uniforms.motion_blur_amount * CURSOR_MULTIPLIER * fps_scale)
            .clamp(0.0, CURSOR_MAX_STRENGTH);
        let child_motion = uniforms
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

        let combined_motion_px = if cursor_strength <= f32::EPSILON {
            XY::new(0.0, 0.0)
        } else {
            child_motion
        };

        // Screen Studio semantics: smear length = per-frame travel x amount,
        // linear all the way down (a sub-pixel kernel is the identity, so no
        // response ramp is needed to avoid popping).
        let scaled_motion = if cursor_strength > f32::EPSILON {
            cursor_blur_vector(combined_motion_px, cursor_strength)
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
            self.cursor_assets_preloaded = false;
        }

        let cursor_texture = if cursor_type == CursorType::Circle {
            if self.circle_cursor.is_none() {
                self.circle_cursor = Some(Self::create_circle_cursor(constants));
            }
            self.circle_cursor.as_ref().unwrap()
        } else {
            if !self.cursor_assets_preloaded {
                self.preload_cursor_textures(constants, uniforms.project.cursor.use_svg);
                self.cursor_assets_preloaded = true;
            }
            if !self.cursors.contains_key(&interpolated_cursor.cursor_id)
                && let Some(texture) = Self::load_cursor_texture(
                    constants,
                    &interpolated_cursor.cursor_id,
                    uniforms.project.cursor.use_svg,
                )
            {
                self.cursors
                    .insert(interpolated_cursor.cursor_id.clone(), texture);
            }
            let Some(tex) = self.cursors.get(&interpolated_cursor.cursor_id) else {
                error!("Cursor {:?} not found!", interpolated_cursor.cursor_id);
                return;
            };
            tex
        };

        let size = {
            let click_t = get_click_t(&cursor.clicks, (time_s as f64) * 1000.0);
            let click_scale_factor = click_t * 1.0 + (1.0 - click_t) * CLICK_SHRINK_SIZE;
            let crop = ProjectUniforms::get_crop(&constants.options, &uniforms.project);
            let display_size = ProjectUniforms::display_size(
                &constants.options,
                &uniforms.project,
                resolution_base,
            );
            let size = cursor_height_px(
                constants.options.screen_size.y as f32,
                crop.size.y as f32,
                display_size.y as f32,
                uniforms.cursor_size,
                click_scale_factor,
            );

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

        // In split-screen the screen only occupies a half-rect, so remap the
        // cursor from its raw source UV into that pane (matching the display
        // layer's split crop -> half-rect mapping) and scale the sprite by the
        // same factor. The cursor shader's screen_bounds clip already follows
        // uniforms.display.target_bounds (the morphing half), so a cursor that
        // lands outside the visible crop is confined automatically.
        let position_size = match &uniforms.split {
            Some(split) if split.factor > 0.001 => {
                let screen_size = constants.options.screen_size;
                let crop = ProjectUniforms::get_crop(&constants.options, &uniforms.project);
                let display_size = ProjectUniforms::display_size(
                    &constants.options,
                    &uniforms.project,
                    resolution_base,
                );

                let scrop = split.screen.crop;
                let starget = split.screen.target;
                let crop_w = (scrop[2] - scrop[0]).max(f32::EPSILON);
                let crop_h = (scrop[3] - scrop[1]).max(f32::EPSILON);
                let target_w = starget[2] - starget[0];
                let target_h = starget[3] - starget[1];

                let cursor_px = [
                    cursor_uv.x as f32 * screen_size.x as f32,
                    cursor_uv.y as f32 * screen_size.y as f32,
                ];
                let tip = [
                    starget[0] + (cursor_px[0] - scrop[0]) / crop_w * target_w,
                    starget[1] + (cursor_px[1] - scrop[1]) / crop_h * target_h,
                ];

                // Source->pane scale (uniform; the split crop matches the pane
                // aspect) relative to the normal source->frame scale.
                let normal_scale = display_size.x as f32 / (crop.size.x as f32).max(f32::EPSILON);
                let size_factor = (target_w / crop_w) / normal_scale.max(f32::EPSILON);

                let split_pos = [
                    tip[0] - hotspot.x as f32 * size_factor,
                    tip[1] - hotspot.y as f32 * size_factor,
                ];
                let split_size = [size.x as f32 * size_factor, size.y as f32 * size_factor];

                let t = split.factor as f32;
                [
                    crate::lerp_f32(zoomed_position.x as f32, split_pos[0], t),
                    crate::lerp_f32(zoomed_position.y as f32, split_pos[1], t),
                    crate::lerp_f32(zoomed_size.x as f32, split_size[0], t),
                    crate::lerp_f32(zoomed_size.y as f32, split_size[1], t),
                ]
            }
            _ => [
                zoomed_position.x as f32,
                zoomed_position.y as f32,
                zoomed_size.x as f32,
                zoomed_size.y as f32,
            ],
        };

        let cursor_uniforms = CursorUniforms {
            position_size,
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
                // Pure on/off gate: the amount is baked into the smear
                // length (scaled_motion), never an opacity mix.
                if cursor_strength > f32::EPSILON {
                    1.0
                } else {
                    0.0
                },
                cursor_opacity,
            ],
            rotation_params: [
                0.0,
                uniforms.project.cursor.base_rotation,
                uniforms.cursor_x_axis_tilt_radians,
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

fn composite_cursor_layer(dst: &mut [f32; 4], src: [f32; 4]) {
    let src_a = src[3];
    if src_a <= 0.0 {
        return;
    }

    let dst_a = dst[3];
    let out_a = src_a + dst_a * (1.0 - src_a);
    if out_a <= 0.0 {
        return;
    }

    for i in 0..3 {
        dst[i] = (src[i] * src_a + dst[i] * dst_a * (1.0 - src_a)) / out_a;
    }
    dst[3] = out_a;
}

fn cursor_height_px(
    source_screen_height: f32,
    crop_height: f32,
    display_frame_height: f32,
    cursor_size: f32,
    click_scale_factor: f32,
) -> f32 {
    let source_screen_height = finite_positive_or(source_screen_height, 1080.0);
    let crop_height = finite_positive_or(crop_height, source_screen_height);
    let display_frame_height = finite_positive_or(display_frame_height, source_screen_height);
    let cursor_size_factor = if cursor_size <= 0.0 {
        1.0
    } else {
        cursor_size / 100.0
    };

    STANDARD_CURSOR_HEIGHT
        * (source_screen_height / 1080.0)
        * (display_frame_height / crop_height)
        * cursor_size_factor
        * click_scale_factor
}

fn finite_positive_or(value: f32, fallback: f32) -> f32 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        fallback
    }
}

fn cursor_blur_vector(motion: XY<f32>, strength: f32) -> XY<f32> {
    clamp_cursor_vector(motion * strength)
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

    let idx = cursor
        .moves
        .partition_point(|e| e.time_ms <= current_time_ms);
    let has_upcoming_move = cursor
        .moves
        .get(idx)
        .is_some_and(|e| e.time_ms - current_time_ms <= CURSOR_IDLE_RESUME_LOOKAHEAD_MS);

    if has_upcoming_move {
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

    let next_click = clicks.iter().find(|c| c.time_ms > time_ms);

    if let Some(next) = next_click {
        if next.down && next.time_ms - time_ms <= CURSOR_CLICK_DURATION_MS {
            return smoothstep(
                0.0,
                CURSOR_CLICK_DURATION_MS as f32,
                (next.time_ms - time_ms) as f32,
            );
        }

        if !next.down {
            return 0.0;
        }
    }

    let prev_click = clicks.iter().rev().find(|c| c.time_ms <= time_ms);

    if let Some(prev) = prev_click {
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
        }
    }

    #[test]
    fn cursor_height_uses_source_relative_default() {
        let height = cursor_height_px(1964.0, 1964.0, 864.0, 100.0, 1.0);
        let expected = STANDARD_CURSOR_HEIGHT * (864.0 / 1080.0);

        assert!((height - expected).abs() < 0.001);
    }

    #[test]
    fn cursor_height_scales_with_source_crop() {
        let height = cursor_height_px(2160.0, 1080.0, 1080.0, 100.0, 1.0);
        let expected = STANDARD_CURSOR_HEIGHT * 2.0;

        assert!((height - expected).abs() < 0.001);
    }

    #[test]
    fn cursor_height_is_zoomed_once_by_frame_transform() {
        let options = crate::RenderOptions {
            camera_size: None,
            screen_size: XY::new(1080, 1080),
            preserve_screen_alpha: false,
        };
        let mut project = ProjectConfiguration::default();
        project.background.padding = 0.0;
        let resolution_base = XY::new(1080, 1080);
        let zoom = InterpolatedZoom {
            t: 1.0,
            bounds: crate::zoom::SegmentBounds::new(XY::new(0.0, 0.0), XY::new(2.0, 2.0)),
        };
        let position = Coord::<FrameSpace>::new(XY::new(0.0, 0.0));
        let size = Coord::<FrameSpace>::new(XY::new(
            0.0,
            cursor_height_px(1080.0, 1080.0, 1080.0, 100.0, 1.0) as f64,
        ));

        let zoomed_position =
            position.to_zoomed_frame_space(&options, &project, resolution_base, &zoom);
        let zoomed_size =
            (position + size).to_zoomed_frame_space(&options, &project, resolution_base, &zoom)
                - zoomed_position;

        assert!((zoomed_size.y as f32 - STANDARD_CURSOR_HEIGHT * 2.0).abs() < 0.001);
    }

    #[test]
    fn cursor_height_applies_project_size_as_percent() {
        let height = cursor_height_px(1080.0, 1080.0, 1080.0, 142.0, 1.0);

        assert!((height - STANDARD_CURSOR_HEIGHT * 1.42).abs() < 0.001);
    }

    #[test]
    fn cursor_height_falls_back_for_invalid_dimensions() {
        let height = cursor_height_px(0.0, 0.0, 720.0, 100.0, 1.0);
        let expected = STANDARD_CURSOR_HEIGHT * (720.0 / 1080.0);

        assert!((height - expected).abs() < 0.001);
    }

    #[test]
    fn cursor_blur_vector_is_linear_in_travel_and_amount() {
        // Screen Studio semantics: smear length == per-frame travel x amount,
        // with no response curve shortening slow-to-medium motion.
        let motion = cursor_blur_vector(XY::new(40.0, -30.0), 0.5);
        assert!((motion.x - 20.0).abs() < 1e-4);
        assert!((motion.y + 15.0).abs() < 1e-4);

        let full = cursor_blur_vector(XY::new(40.0, -30.0), 1.0);
        assert!((full.x - 40.0).abs() < 1e-4);
        assert!((full.y + 30.0).abs() < 1e-4);
    }

    #[test]
    fn cursor_blur_vector_caps_only_teleports() {
        // Real flicks stay untouched...
        let flick = cursor_blur_vector(XY::new(200.0, 0.0), 1.0);
        assert!((flick.x - 200.0).abs() < 1e-4);

        // ...only pathological single-frame jumps hit the safety cap.
        let teleport = cursor_blur_vector(XY::new(5000.0, 0.0), 1.0);
        let len = (teleport.x * teleport.x + teleport.y * teleport.y).sqrt();
        assert!(len <= CURSOR_VECTOR_CAP + f32::EPSILON);
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
