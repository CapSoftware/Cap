use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::{composite_frame::CompositeVideoFrameUniforms, screen_upscale_net::ScreenUpscaleNet};

/// What a frame is rendered for. Enhancement runs for exports and for a
/// paused editor preview, never during playback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RenderQuality {
    #[default]
    Playback,
    PausedPreview,
    Export,
}

impl RenderQuality {
    pub fn enhances(self) -> bool {
        !matches!(self, Self::Playback)
    }
}

const GATE_STEP: f32 = 1.0 / 16.0;
const UPSCALE_FULL_MOTION_PX: f32 = 4.0;
const UPSCALE_ZERO_MOTION_PX: f32 = 28.0;
const TRAIL_FULL_PX: f32 = 4.0;
const TRAIL_ZERO_PX: f32 = 8.0;
const MAGNIFICATION_START: f32 = 1.02;
const MAGNIFICATION_FULL: f32 = 1.2;
pub const UPSCALE_MIN_STRENGTH: f32 = 0.2;
const DEBAND_FULL_MOTION_PX: f32 = 10.0;
const DEBAND_ZERO_MOTION_PX: f32 = 30.0;
const DEBAND_MAX_STEPS: f32 = 4.0;
const DEBAND_MAX_ITERATIONS: f32 = 4.0;
const DEBAND_RADIUS_TEXELS: f32 = 16.0;
const DEBAND_MIN_DENSITY: f32 = std::f32::consts::FRAC_1_SQRT_2;
const RCAS_SHARPNESS_STOPS: f32 = 0.2;
const MAX_REGION_AREA: u64 = 24_000_000;
const PASS_TARGET_USAGE: wgpu::TextureUsages =
    wgpu::TextureUsages::TEXTURE_BINDING.union(wgpu::TextureUsages::RENDER_ATTACHMENT);
/// Source texels the network reads around the visible crop: its own reach
/// plus the resampling taps of the region pass.
const NETWORK_MARGIN: f32 = crate::screen_upscale_net::HALO as f32 + 4.0;
const MAX_REGION_DIMENSION: u32 = 8192;

fn quantize(value: f32) -> f32 {
    ((value / GATE_STEP).round() * GATE_STEP).clamp(0.0, 1.0)
}

fn fade(value: f32, full: f32, zero: f32) -> f32 {
    ((value - full) / (zero - full).max(1e-6)).clamp(0.0, 1.0)
}

fn linear_gate(value: f32, full: f32, zero: f32) -> f32 {
    quantize(1.0 - fade(value, full, zero))
}

fn smooth_gate(value: f32, full: f32, zero: f32) -> f32 {
    let t = fade(value, full, zero);
    quantize(1.0 - t * t * (3.0 - 2.0 * t))
}

fn magnification_gate(magnification: f32) -> f32 {
    ((magnification - MAGNIFICATION_START) / (MAGNIFICATION_FULL - MAGNIFICATION_START))
        .clamp(0.0, 1.0)
}

/// How much of the upscaled image replaces the plain sample. Zero below
/// [`UPSCALE_MIN_STRENGTH`], for moving content (more than 28 output px per
/// frame for the slowest pixel, or a visible motion-blur trail) and for
/// content that is not magnified.
pub fn upscale_strength(motion_px: f32, motion_blur_amount: f32, magnification: f32) -> f32 {
    let motion = motion_px.max(0.0);
    let strength = quantize(
        linear_gate(motion, UPSCALE_FULL_MOTION_PX, UPSCALE_ZERO_MOTION_PX)
            * smooth_gate(
                motion * motion_blur_amount.max(0.0),
                TRAIL_FULL_PX,
                TRAIL_ZERO_PX,
            )
            * magnification_gate(magnification),
    );
    if strength < UPSCALE_MIN_STRENGTH {
        0.0
    } else {
        strength
    }
}

/// Deband threshold (in unorm) and iteration count for a setting strength.
/// At the default 0.5 this is two 8-bit levels over two iterations; the
/// threshold fades out as the screen moves.
pub fn deband_params(
    strength: f32,
    motion_px: f32,
    motion_blur_amount: f32,
    magnification: f32,
) -> (f32, u32) {
    let strength = strength.clamp(0.0, 1.0);
    if strength <= 0.0 || magnification < DEBAND_MIN_DENSITY {
        return (0.0, 0);
    }
    let steps = strength * DEBAND_MAX_STEPS;
    let iterations = (strength * DEBAND_MAX_ITERATIONS)
        .ceil()
        .clamp(1.0, DEBAND_MAX_ITERATIONS) as u32;
    let gate = smooth_gate(
        motion_px.max(0.0) * motion_blur_amount.max(0.0),
        DEBAND_FULL_MOTION_PX,
        DEBAND_ZERO_MOTION_PX,
    );
    let threshold = steps * gate / 255.0;
    if threshold <= 0.0 {
        (0.0, 0)
    } else {
        (threshold, iterations)
    }
}

/// Per-axis distance the slowest-moving pixel of a rect travels between two
/// frames. Zero along an axis whose edges move in opposite directions, since
/// some pixel between them stays still (a zoom about a visible point).
pub fn slowest_pixel_motion(current: [f32; 4], previous: [f32; 4]) -> f32 {
    fn axis(start: f32, end: f32) -> f32 {
        if start * end <= 0.0 {
            0.0
        } else {
            start.abs().min(end.abs())
        }
    }
    let x = axis(current[0] - previous[0], current[2] - previous[2]);
    let y = axis(current[1] - previous[1], current[3] - previous[3]);
    x.hypot(y)
}

/// Enhancement for one frame of the screen, resolved from the project
/// setting, the screen's magnification and its motion. Applied only when the
/// frame renders with a [`RenderQuality`] that enhances.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ScreenEnhanceFrame {
    pub deband_threshold: f32,
    pub deband_iterations: u32,
    pub upscale_strength: f32,
    /// The screen is drawn smaller than its source: the composite shader
    /// samples it with an 8-tap filter instead of the 4 to 5 tap one.
    pub detail_downscale: bool,
}

impl ScreenEnhanceFrame {
    pub const NONE: Self = Self {
        deband_threshold: 0.0,
        deband_iterations: 0,
        upscale_strength: 0.0,
        detail_downscale: false,
    };

    pub fn resolve(
        setting_strength: f32,
        motion_px: f32,
        motion_blur_amount: f32,
        magnification: f32,
    ) -> Self {
        if setting_strength <= 0.0 || !magnification.is_finite() || !motion_px.is_finite() {
            return Self::NONE;
        }
        let (deband_threshold, deband_iterations) = deband_params(
            setting_strength,
            motion_px,
            motion_blur_amount,
            magnification,
        );
        // The default strength (0.5) gives the full upscale; lower settings
        // fade it out, and the 0.2 floor still applies after scaling.
        let scaled = quantize(
            upscale_strength(motion_px, motion_blur_amount, magnification)
                * (setting_strength * 2.0).min(1.0),
        );
        Self {
            deband_threshold,
            deband_iterations,
            upscale_strength: if scaled < UPSCALE_MIN_STRENGTH {
                0.0
            } else {
                scaled
            },
            detail_downscale: magnification < 1.0,
        }
    }

    pub fn debands(&self) -> bool {
        self.deband_threshold > 0.0 && self.deband_iterations > 0
    }

    pub fn upscales(&self) -> bool {
        self.upscale_strength >= UPSCALE_MIN_STRENGTH
    }

    pub fn is_active(&self) -> bool {
        self.debands() || self.upscales() || self.detail_downscale
    }

    fn detail_flag(&self) -> f32 {
        if self.detail_downscale { 1.0 } else { 0.0 }
    }

    /// `enhance_params` for the composite shader: (upscale mix, detail
    /// downscale flag, unused, unused).
    pub fn shader_params(&self, upscale_mix: f32) -> [f32; 4] {
        [upscale_mix, self.detail_flag(), 0.0, 0.0]
    }
}

pub fn magnification(uniforms: &CompositeVideoFrameUniforms) -> f32 {
    let crop_w = (uniforms.crop_bounds[2] - uniforms.crop_bounds[0]).max(f32::EPSILON);
    let crop_h = (uniforms.crop_bounds[3] - uniforms.crop_bounds[1]).max(f32::EPSILON);
    (uniforms.target_size[0] / crop_w).min(uniforms.target_size[1] / crop_h)
}

/// Output-pixel rect `[x0, y0, x1, y1]` of the screen that is on screen, or
/// `None` when nothing is visible or the region is too large to upscale.
pub fn upscale_region(
    uniforms: &CompositeVideoFrameUniforms,
    max_dimension: u32,
) -> Option<[u32; 4]> {
    let x0 = uniforms.target_bounds[0].max(0.0).floor();
    let y0 = uniforms.target_bounds[1].max(0.0).floor();
    let x1 = uniforms.target_bounds[2]
        .min(uniforms.output_size[0])
        .ceil();
    let y1 = uniforms.target_bounds[3]
        .min(uniforms.output_size[1])
        .ceil();
    if !(x1 > x0 && y1 > y0) {
        return None;
    }
    let (x0, y0, x1, y1) = (x0 as u32, y0 as u32, x1 as u32, y1 as u32);
    let width = x1 - x0;
    let height = y1 - y0;
    let limit = max_dimension.min(MAX_REGION_DIMENSION);
    if width > limit || height > limit || u64::from(width) * u64::from(height) > MAX_REGION_AREA {
        return None;
    }
    Some([x0, y0, x1, y1])
}

/// Source texels `[x0, y0, x1, y1]` the network upscales for an output
/// region: the part of the crop the region shows, with a margin, inside both
/// the crop and the frame.
fn network_rect(
    uniforms: &CompositeVideoFrameUniforms,
    region: [u32; 4],
    source_size: [u32; 2],
) -> Option<[u32; 4]> {
    let axis = |axis: usize| -> Option<(u32, u32)> {
        let size = uniforms.target_size[axis];
        let crop_min = uniforms.crop_bounds[axis];
        let crop_max = uniforms.crop_bounds[axis + 2];
        let lo = crop_min.floor().max(0.0);
        let hi = crop_max.ceil().min(source_size[axis] as f32);
        if size <= 0.0
            || !size.is_finite()
            || hi.partial_cmp(&lo) != Some(std::cmp::Ordering::Greater)
        {
            return None;
        }
        let to_uv = |px: u32| ((px as f32 - uniforms.target_bounds[axis]) / size).clamp(0.0, 1.0);
        let (mut a, mut b) = (to_uv(region[axis]), to_uv(region[axis + 2]));
        if axis == 0 && uniforms.mirror_x != 0.0 {
            (a, b) = (1.0 - b, 1.0 - a);
        }
        let span = crop_max - crop_min;
        let start = (crop_min + a * span - NETWORK_MARGIN).floor();
        let end = (crop_min + b * span + NETWORK_MARGIN).ceil();
        if !start.is_finite() || !end.is_finite() {
            return None;
        }
        let (start, end) = (start.clamp(lo, hi) as u32, end.clamp(lo, hi) as u32);
        (end > start).then_some((start, end))
    };
    let (x0, x1) = axis(0)?;
    let (y0, y1) = axis(1)?;
    Some([x0, y0, x1, y1])
}

#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
struct EnhanceUniforms {
    frame_size: [f32; 2],
    region_origin: [f32; 2],
    target_origin: [f32; 2],
    target_size: [f32; 2],
    crop_min: [f32; 2],
    crop_max: [f32; 2],
    deband: [f32; 4],
    params: [f32; 4],
}

impl EnhanceUniforms {
    fn new(uniforms: &CompositeVideoFrameUniforms, frame: &ScreenEnhanceFrame) -> Self {
        Self {
            frame_size: uniforms.frame_size,
            region_origin: [0.0; 2],
            target_origin: [uniforms.target_bounds[0], uniforms.target_bounds[1]],
            target_size: uniforms.target_size,
            crop_min: [uniforms.crop_bounds[0], uniforms.crop_bounds[1]],
            crop_max: [uniforms.crop_bounds[2], uniforms.crop_bounds[3]],
            deband: [
                frame.deband_threshold,
                frame.deband_iterations as f32,
                DEBAND_RADIUS_TEXELS,
                0.0,
            ],
            params: [(-RCAS_SHARPNESS_STOPS).exp2(), uniforms.mirror_x, 0.0, 0.0],
        }
    }
}

pub struct ScreenEnhancePipelines {
    layout: wgpu::BindGroupLayout,
    deband: wgpu::RenderPipeline,
    upscale: wgpu::RenderPipeline,
    rcas: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
}

impl ScreenEnhancePipelines {
    pub fn new(device: &wgpu::Device) -> Self {
        let shader =
            device.create_shader_module(wgpu::include_wgsl!("shaders/screen-enhance.wgsl"));
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Screen enhance bind group layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
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
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Screen enhance pipeline layout"),
            bind_group_layouts: &[&layout],
            push_constant_ranges: &[],
        });
        let pipeline = |entry_point: &str, label: &str| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(entry_point),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Screen enhance sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        Self {
            deband: pipeline("fs_deband", "Screen deband pipeline"),
            upscale: pipeline("fs_upscale", "Screen upscale pipeline"),
            rcas: pipeline("fs_rcas", "Screen RCAS pipeline"),
            layout,
            sampler,
        }
    }
}

struct EnhanceTarget {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
}

impl EnhanceTarget {
    fn ensure(
        slot: &mut Option<Self>,
        device: &wgpu::Device,
        width: u32,
        height: u32,
        exact: bool,
        usage: wgpu::TextureUsages,
        label: &str,
    ) -> bool {
        let fits = slot.as_ref().is_some_and(|target| {
            if target.texture.usage() != usage {
                return false;
            }
            let (w, h) = (target.texture.width(), target.texture.height());
            if exact {
                w == width && h == height
            } else {
                w >= width && h >= height
            }
        });
        if fits {
            return false;
        }
        let (width, height) = match slot.as_ref() {
            Some(target) if !exact && target.texture.usage() == usage => (
                target.texture.width().max(width),
                target.texture.height().max(height),
            ),
            _ => (width, height),
        };
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        *slot = Some(Self { texture, view });
        true
    }
}

/// The decoded screen frame to enhance. `frame_id` changes whenever the
/// texture behind `view` gets new content.
pub struct EnhanceInput<'a> {
    pub view: &'a wgpu::TextureView,
    pub size: [u32; 2],
    pub frame_id: u64,
}

/// Textures an enhanced frame is drawn from: the debanded source (or `None`
/// to keep the original) and the upscaled region with its output-pixel rect.
pub struct EnhancedViews<'a> {
    pub source: Option<&'a wgpu::TextureView>,
    pub upscaled: Option<(&'a wgpu::TextureView, [u32; 4])>,
}

/// The decoded frame and deband settings a deband result was made from.
#[derive(Debug, Clone, Copy, PartialEq)]
struct DebandKey {
    frame: u64,
    threshold: u32,
    iterations: u32,
}

/// The input and source rect a network result was made from. A paused
/// preview, or an export at a higher frame rate than the recording, renders
/// the same decoded frame more than once; those renders reuse the result.
#[derive(Debug, Clone, Copy, PartialEq)]
struct NetKey {
    frame: u64,
    deband: Option<DebandKey>,
    rect: [u32; 4],
    deep: bool,
}

/// The display layer's enhancement passes. Textures are allocated the first
/// time a frame needs them, so projects with enhancement off never pay for
/// them.
pub struct ScreenEnhancer {
    pipelines: ScreenEnhancePipelines,
    deband_target: Option<EnhanceTarget>,
    upscale_target: Option<EnhanceTarget>,
    sharpen_target: Option<EnhanceTarget>,
    net: Option<ScreenUpscaleNet>,
    net_target: Option<EnhanceTarget>,
    deband_key: Option<DebandKey>,
    net_key: Option<NetKey>,
    upscale_region: Option<[u32; 4]>,
    sharpened: bool,
    debanded: bool,
}

impl ScreenEnhancer {
    pub fn new(device: &wgpu::Device) -> Self {
        Self {
            pipelines: ScreenEnhancePipelines::new(device),
            deband_target: None,
            upscale_target: None,
            sharpen_target: None,
            net: None,
            net_target: None,
            deband_key: None,
            net_key: None,
            upscale_region: None,
            sharpened: false,
            debanded: false,
        }
    }

    fn pass(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        pipeline: &wgpu::RenderPipeline,
        uniforms: &EnhanceUniforms,
        source: &wgpu::TextureView,
        (target, viewport): (&wgpu::TextureView, [u32; 2]),
    ) {
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Screen enhance uniforms"),
            contents: bytemuck::bytes_of(uniforms),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Screen enhance bind group"),
            layout: &self.pipelines.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(source),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.pipelines.sampler),
                },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Screen enhance pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        pass.set_viewport(0.0, 0.0, viewport[0] as f32, viewport[1] as f32, 0.0, 1.0);
        pass.set_scissor_rect(0, 0, viewport[0], viewport[1]);
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.draw(0..3, 0..1);
    }

    /// Records the passes `frame` asks for, reading `source` (the decoded
    /// screen frame). Returns whether anything was produced.
    pub fn encode(
        &mut self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        input: EnhanceInput<'_>,
        uniforms: &CompositeVideoFrameUniforms,
        frame: &ScreenEnhanceFrame,
    ) -> bool {
        let EnhanceInput {
            view: source,
            size: source_size,
            frame_id,
        } = input;
        self.debanded = false;
        self.sharpened = false;
        self.upscale_region = None;
        if !(frame.debands() || frame.upscales()) || source_size[0] == 0 || source_size[1] == 0 {
            return false;
        }

        let base = EnhanceUniforms::new(uniforms, frame);
        let deband_key = frame.debands().then_some(DebandKey {
            frame: frame_id,
            threshold: frame.deband_threshold.to_bits(),
            iterations: frame.deband_iterations,
        });
        if let Some(key) = deband_key {
            if EnhanceTarget::ensure(
                &mut self.deband_target,
                device,
                source_size[0],
                source_size[1],
                true,
                PASS_TARGET_USAGE,
                "Screen deband texture",
            ) {
                self.deband_key = None;
            }
            if let Some(target) = &self.deband_target {
                if self.deband_key != Some(key) {
                    self.pass(
                        device,
                        encoder,
                        &self.pipelines.deband,
                        &base,
                        source,
                        (&target.view, source_size),
                    );
                    self.deband_key = Some(key);
                }
                self.debanded = true;
            }
        }

        let region = frame
            .upscales()
            .then(|| upscale_region(uniforms, device.limits().max_texture_dimension_2d))
            .flatten();
        if let Some(region) = region {
            let size = [region[2] - region[0], region[3] - region[1]];
            EnhanceTarget::ensure(
                &mut self.upscale_target,
                device,
                size[0],
                size[1],
                false,
                PASS_TARGET_USAGE,
                "Screen upscale texture",
            );
            let upscale_source = match (&self.deband_target, self.debanded) {
                (Some(target), true) => &target.view,
                _ => source,
            };
            let mut upscale_uniforms = base;
            upscale_uniforms.region_origin = [region[0] as f32, region[1] as f32];
            upscale_uniforms.params[2] = size[0] as f32;
            upscale_uniforms.params[3] = size[1] as f32;
            let max_dimension = device.limits().max_texture_dimension_2d;
            let net_rect = network_rect(uniforms, region, source_size)
                .filter(|rect| 2 * (rect[2] - rect[0]).max(rect[3] - rect[1]) <= max_dimension);
            if let Some(rect) = net_rect {
                let net_size = [2 * (rect[2] - rect[0]), 2 * (rect[3] - rect[1])];
                let reallocated = EnhanceTarget::ensure(
                    &mut self.net_target,
                    device,
                    net_size[0],
                    net_size[1],
                    false,
                    wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING,
                    "Screen network texture",
                );
                let deep =
                    magnification(uniforms) >= crate::screen_upscale_net::DEEP_FROM_MAGNIFICATION;
                let key = NetKey {
                    frame: frame_id,
                    deband: deband_key.filter(|_| self.debanded),
                    rect,
                    deep,
                };
                if let Some(net_target) = &self.net_target {
                    if reallocated || self.net_key != Some(key) {
                        self.net
                            .get_or_insert_with(|| ScreenUpscaleNet::new(device))
                            .encode(
                                device,
                                encoder,
                                (upscale_source, source_size),
                                rect,
                                &net_target.view,
                                deep,
                            );
                        self.net_key = Some(key);
                    }
                    let origin = [rect[0] as f32, rect[1] as f32];
                    upscale_uniforms.frame_size = [
                        net_target.texture.width() as f32,
                        net_target.texture.height() as f32,
                    ];
                    upscale_uniforms.crop_min = [
                        2.0 * (upscale_uniforms.crop_min[0] - origin[0]),
                        2.0 * (upscale_uniforms.crop_min[1] - origin[1]),
                    ];
                    upscale_uniforms.crop_max = [
                        2.0 * (upscale_uniforms.crop_max[0] - origin[0]),
                        2.0 * (upscale_uniforms.crop_max[1] - origin[1]),
                    ];
                    upscale_uniforms.deband[3] = 1.0;
                }
            }
            let network = upscale_uniforms.deband[3] != 0.0;
            let upscale_input = match (&self.net_target, network) {
                (Some(target), true) => &target.view,
                _ => upscale_source,
            };
            if let Some(upscaled) = &self.upscale_target {
                self.pass(
                    device,
                    encoder,
                    &self.pipelines.upscale,
                    &upscale_uniforms,
                    upscale_input,
                    (&upscaled.view, size),
                );
                self.upscale_region = Some(region);
                if network {
                    // The network's output is final; the sharpen target is
                    // only for the plain fallback.
                    self.sharpen_target = None;
                    return true;
                }
                EnhanceTarget::ensure(
                    &mut self.sharpen_target,
                    device,
                    size[0],
                    size[1],
                    false,
                    PASS_TARGET_USAGE,
                    "Screen sharpen texture",
                );
                if let Some(sharpened) = &self.sharpen_target {
                    self.sharpened = true;
                    self.pass(
                        device,
                        encoder,
                        &self.pipelines.rcas,
                        &upscale_uniforms,
                        &upscaled.view,
                        (&sharpened.view, size),
                    );
                }
            }
        }

        self.debanded || self.upscale_region.is_some()
    }

    pub fn views(&self) -> EnhancedViews<'_> {
        EnhancedViews {
            source: self
                .deband_target
                .as_ref()
                .filter(|_| self.debanded)
                .map(|target| &target.view),
            upscaled: if self.sharpened {
                self.sharpen_target.as_ref()
            } else {
                self.upscale_target.as_ref()
            }
            .zip(self.upscale_region)
            .map(|(target, region)| (&target.view, region)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_strength_debands_two_levels_twice() {
        let (threshold, iterations) = deband_params(0.5, 0.0, 1.0, 1.0);
        assert!((threshold * 255.0 - 2.0).abs() < 1e-5);
        assert_eq!(iterations, 2);
    }

    #[test]
    fn deband_scales_with_strength_and_caps_iterations() {
        let (threshold, iterations) = deband_params(1.0, 0.0, 1.0, 1.0);
        assert!((threshold * 255.0 - 4.0).abs() < 1e-5);
        assert_eq!(iterations, 4);
        let (threshold, iterations) = deband_params(0.1, 0.0, 1.0, 1.0);
        assert!((threshold * 255.0 - 0.4).abs() < 1e-5);
        assert_eq!(iterations, 1);
        assert_eq!(deband_params(0.0, 0.0, 1.0, 1.0), (0.0, 0));
    }

    #[test]
    fn deband_fades_with_motion_and_skips_heavy_downscale() {
        let still = deband_params(0.5, 0.0, 1.0, 1.0).0;
        let mid = deband_params(0.5, 20.0, 1.0, 1.0).0;
        assert!(mid > 0.0 && mid < still);
        assert_eq!(deband_params(0.5, 30.0, 1.0, 1.0), (0.0, 0));
        assert_eq!(deband_params(0.5, 30.0, 0.0, 1.0).0, still);
        assert_eq!(deband_params(0.5, 0.0, 1.0, 0.5), (0.0, 0));
    }

    #[test]
    fn upscale_needs_magnification_and_stillness() {
        assert_eq!(upscale_strength(0.0, 1.0, 1.0), 0.0);
        assert_eq!(upscale_strength(0.0, 1.0, 1.05), 0.0);
        assert_eq!(upscale_strength(0.0, 1.0, 1.2), 1.0);
        assert_eq!(upscale_strength(0.0, 1.0, 2.0), 1.0);
        assert_eq!(upscale_strength(4.0, 0.0, 2.0), 1.0);
        assert_eq!(upscale_strength(28.0, 0.0, 2.0), 0.0);
        assert_eq!(upscale_strength(16.0, 0.0, 2.0), 0.5);
        assert_eq!(upscale_strength(8.0, 1.0, 2.0), 0.0);
        assert_eq!(upscale_strength(6.0, 1.0, 2.0), 0.5);
    }

    #[test]
    fn strengths_land_on_sixteenths() {
        for motion in 0..40 {
            let strength = upscale_strength(motion as f32 * 0.7, 0.3, 1.13);
            assert_eq!((strength * 16.0).fract(), 0.0, "{strength}");
        }
    }

    #[test]
    fn slowest_pixel_is_still_inside_a_zoom() {
        let before = [100.0, 100.0, 1100.0, 700.0];
        let zoomed = [50.0, 70.0, 1150.0, 730.0];
        assert_eq!(slowest_pixel_motion(zoomed, before), 0.0);
        let panned = [90.0, 100.0, 1095.0, 700.0];
        assert_eq!(slowest_pixel_motion(panned, before), 5.0);
        let diagonal = [103.0, 104.0, 1103.0, 704.0];
        assert_eq!(slowest_pixel_motion(diagonal, before), 5.0);
    }

    #[test]
    fn strength_scales_the_upscale_below_the_default() {
        let at = |strength| ScreenEnhanceFrame::resolve(strength, 0.0, 1.0, 2.0).upscale_strength;
        assert_eq!(at(1.0), 1.0);
        assert_eq!(at(0.5), 1.0);
        assert_eq!(at(0.25), 0.5);
        assert_eq!(at(0.05), 0.0);
    }

    #[test]
    fn resolve_is_off_without_strength() {
        assert_eq!(
            ScreenEnhanceFrame::resolve(0.0, 0.0, 1.0, 2.0),
            ScreenEnhanceFrame::NONE
        );
        let on = ScreenEnhanceFrame::resolve(0.5, 0.0, 1.0, 2.0);
        assert!(on.debands() && on.upscales());
        let unzoomed = ScreenEnhanceFrame::resolve(0.5, 0.0, 1.0, 1.0);
        assert!(unzoomed.debands() && !unzoomed.upscales());
    }

    #[test]
    fn detail_downscale_is_only_for_a_shrunk_screen() {
        let at = |strength, magnification| {
            ScreenEnhanceFrame::resolve(strength, 0.0, 1.0, magnification)
        };
        assert!(at(0.5, 0.5).detail_downscale && at(0.5, 0.5).is_active());
        assert_eq!(at(0.5, 0.5).shader_params(0.0), [0.0, 1.0, 0.0, 0.0]);
        assert!(!at(0.5, 1.0).detail_downscale);
        assert!(!at(0.5, 2.0).detail_downscale);
        assert_eq!(at(0.0, 0.5), ScreenEnhanceFrame::NONE);
    }

    #[test]
    fn network_reads_only_the_visible_crop() {
        let card = CompositeVideoFrameUniforms {
            output_size: [192.0, 128.0],
            target_bounds: [0.0, 0.0, 192.0, 128.0],
            target_size: [192.0, 128.0],
            crop_bounds: [0.0, 0.0, 96.0, 64.0],
            ..Default::default()
        };
        assert_eq!(
            network_rect(&card, [0, 0, 192, 128], [96, 64]),
            Some([0, 0, 96, 64])
        );
        let left = network_rect(&card, [0, 0, 64, 128], [96, 64]).expect("left third");
        assert_eq!((left[0], left[2]), (0, 32 + NETWORK_MARGIN as u32));
        let mirrored = CompositeVideoFrameUniforms {
            mirror_x: 1.0,
            ..card
        };
        let right = network_rect(&mirrored, [0, 0, 96, 128], [96, 64]).expect("mirrored");
        assert_eq!((right[0], right[2]), (48 - NETWORK_MARGIN as u32, 96));
        let past_frame = CompositeVideoFrameUniforms {
            crop_bounds: [200.0, 0.0, 300.0, 64.0],
            ..card
        };
        assert_eq!(network_rect(&past_frame, [0, 0, 192, 128], [96, 64]), None);
        let nan = CompositeVideoFrameUniforms {
            crop_bounds: [f32::NAN, 0.0, 96.0, 64.0],
            ..card
        };
        assert_eq!(network_rect(&nan, [0, 0, 192, 128], [96, 64]), None);
    }

    #[test]
    fn region_is_the_visible_part_of_the_card() {
        let uniforms = CompositeVideoFrameUniforms {
            output_size: [1920.0, 1080.0],
            target_bounds: [-400.5, -200.0, 2300.25, 1300.0],
            ..Default::default()
        };
        assert_eq!(upscale_region(&uniforms, 16384), Some([0, 0, 1920, 1080]));
        let inside = CompositeVideoFrameUniforms {
            output_size: [1920.0, 1080.0],
            target_bounds: [100.4, 50.6, 1800.2, 1000.9],
            ..Default::default()
        };
        assert_eq!(upscale_region(&inside, 16384), Some([100, 50, 1801, 1001]));
        assert_eq!(upscale_region(&inside, 1024), None);
        let offscreen = CompositeVideoFrameUniforms {
            output_size: [1920.0, 1080.0],
            target_bounds: [2000.0, 0.0, 2500.0, 500.0],
            ..Default::default()
        };
        assert_eq!(upscale_region(&offscreen, 16384), None);
    }
}
