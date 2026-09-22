#[path = "../../../../crates/rendering/src/layers/animated_gradient.rs"]
mod animated_gradient;
#[path = "../../../../crates/rendering/src/layers/blur.rs"]
mod blur;
#[path = "../../../../crates/rendering/src/composite_frame.rs"]
mod composite_frame;
#[path = "../../../../crates/editor/src/screen_recording_defaults.rs"]
mod screen_recording_defaults;
#[path = "../../../../crates/rendering/src/segment_timing.rs"]
mod segment_timing;
#[path = "../../../../crates/rendering/src/transition.rs"]
mod transition;

use animated_gradient::AnimatedGradientLayer;
use blur::BlurLayer;
use bytemuck::{Pod, Zeroable};
use cap_project::{
    AnimatedGradientConfig, AspectRatio, BackgroundSource, CameraShape, CameraXPosition,
    CameraYPosition, ClipConfiguration, ClipOffsets, ClipTransitionType, CornerStyle,
    ProjectConfiguration, StudioRecordingMeta, TimelineConfiguration, TimelineFrameMapping,
    TimelineSource,
};
use composite_frame::{
    ColorGradeUniformParams, CompositeVideoFramePipeline, CompositeVideoFrameUniforms,
};
use segment_timing::{SegmentVideoTiming, segment_video_timing};
use std::cell::Cell;
use transition::{TransitionCompositor, TransitionParameters};
use wasm_bindgen::JsCast;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{HtmlCanvasElement, HtmlVideoElement, ImageBitmap, WebGl2RenderingContext};
use wgpu::util::DeviceExt;

struct ProjectUniforms {
    output_size: (u32, u32),
    frame_number: u32,
    frame_rate: u32,
}

fn js_error(value: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&value.to_string())
}

fn trace_renderer(stage: &str) {
    let Some(window) = web_sys::window() else {
        return;
    };
    if js_sys::Reflect::get(
        window.as_ref(),
        &JsValue::from_str("CapBrowserRendererTrace"),
    )
    .ok()
    .and_then(|value| value.as_bool())
        != Some(true)
    {
        return;
    }
    web_sys::console::info_1(&JsValue::from_str(&format!("Cap renderer stage: {stage}")));
}

async fn wait_for_gpu_poll() -> Result<(), JsValue> {
    let promise = js_sys::Promise::new(&mut |resolve, reject| {
        let Some(window) = web_sys::window() else {
            let _ = reject.call1(&JsValue::NULL, &js_error("Browser window is unavailable"));
            return;
        };
        let callback = Closure::once(move || {
            let _ = resolve.call0(&JsValue::NULL);
        });
        match window.set_timeout_with_callback_and_timeout_and_arguments_0(
            callback.as_ref().unchecked_ref(),
            8,
        ) {
            Ok(_) => callback.forget(),
            Err(error) => {
                let _ = reject.call1(&JsValue::NULL, &error);
            }
        }
    });
    JsFuture::from(promise).await.map(|_| ())
}

#[wasm_bindgen]
pub fn default_project_config_json() -> Result<String, JsValue> {
    serde_json::to_string(&screen_recording_defaults::default_screen_recording_project_config())
        .map_err(js_error)
}

#[wasm_bindgen]
pub fn animated_gradient_catalog_json() -> Result<String, JsValue> {
    serde_json::to_string(&cap_project::animated_gradient_catalog()).map_err(js_error)
}

#[wasm_bindgen]
pub fn random_animated_gradient_json(seed: u32) -> Result<String, JsValue> {
    serde_json::to_string(&cap_project::AnimatedGradientConfig::from_seed(seed)).map_err(js_error)
}

fn source_values(source: TimelineSource<'_>) -> [f64; 3] {
    [
        source.segment_index as f64,
        source.segment.recording_clip as f64,
        source.source_time,
    ]
}

#[wasm_bindgen]
pub struct BrowserTimeline {
    timeline: TimelineConfiguration,
}

#[wasm_bindgen]
impl BrowserTimeline {
    #[wasm_bindgen(constructor)]
    pub fn new(timeline_json: &str) -> Result<BrowserTimeline, JsValue> {
        Ok(Self {
            timeline: serde_json::from_str(timeline_json).map_err(js_error)?,
        })
    }

    pub fn map_frame(&self, time: f64) -> Vec<f64> {
        if !time.is_finite() {
            return Vec::new();
        }
        match self.timeline.get_frame_mapping(time) {
            None => Vec::new(),
            Some(TimelineFrameMapping::Single { source, output_end }) => {
                let [index, clip, source_time] = source_values(source);
                vec![
                    0.0,
                    index,
                    clip,
                    source_time,
                    -1.0,
                    -1.0,
                    -1.0,
                    -1.0,
                    0.0,
                    0.0,
                    output_end,
                ]
            }
            Some(TimelineFrameMapping::Hold { source, output_end }) => {
                let [index, clip, source_time] = source_values(source);
                vec![
                    1.0,
                    index,
                    clip,
                    source_time,
                    -1.0,
                    -1.0,
                    -1.0,
                    -1.0,
                    0.0,
                    0.0,
                    output_end,
                ]
            }
            Some(TimelineFrameMapping::Transition {
                outgoing,
                incoming,
                kind,
                progress,
                duration,
                output_end,
            }) => {
                let [index, clip, source_time] = source_values(incoming);
                let [outgoing_index, outgoing_clip, outgoing_time] = source_values(outgoing);
                let kind = match kind {
                    ClipTransitionType::CrossFade => 0.0,
                    ClipTransitionType::FadeThroughBlack => 1.0,
                };
                vec![
                    2.0,
                    index,
                    clip,
                    source_time,
                    outgoing_index,
                    outgoing_clip,
                    outgoing_time,
                    kind,
                    progress,
                    duration,
                    output_end,
                ]
            }
        }
    }
}

#[wasm_bindgen]
pub struct BrowserRecordingTimes {
    timings: Vec<SegmentVideoTiming>,
    offsets: Vec<ClipOffsets>,
    audio_present: Vec<[bool; 2]>,
}

#[wasm_bindgen]
impl BrowserRecordingTimes {
    #[wasm_bindgen(constructor)]
    pub fn new(meta_json: &str, clips_json: &str) -> Result<BrowserRecordingTimes, JsValue> {
        let meta: StudioRecordingMeta = serde_json::from_str(meta_json).map_err(js_error)?;
        let clips: Vec<ClipConfiguration> = serde_json::from_str(clips_json).map_err(js_error)?;
        let count = match &meta {
            StudioRecordingMeta::SingleSegment { .. } => 1,
            StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
        };
        if count == 0 {
            return Err(js_error("Recording contains no video segments"));
        }
        let timings = (0..count)
            .map(|index| segment_video_timing(&meta, index))
            .collect();
        let (mut offsets, audio_present) = match &meta {
            StudioRecordingMeta::SingleSegment { segment } => (
                vec![ClipOffsets::default()],
                vec![[segment.audio.is_some(), false]],
            ),
            StudioRecordingMeta::MultipleSegments { inner } => (
                inner
                    .segments
                    .iter()
                    .map(|segment| segment.calculate_audio_offsets())
                    .collect(),
                inner
                    .segments
                    .iter()
                    .map(|segment| [segment.mic.is_some(), segment.system_audio.is_some()])
                    .collect(),
            ),
        };
        for clip in clips {
            let index = clip.index as usize;
            if index < count {
                offsets[index] = clip.offsets;
            }
        }
        Ok(Self {
            timings,
            offsets,
            audio_present,
        })
    }

    pub fn source_times(&self, segment_index: usize, source_time: f64) -> Vec<f64> {
        if !source_time.is_finite() {
            return Vec::new();
        }
        let Some(timing) = self.timings.get(segment_index) else {
            return Vec::new();
        };
        let Some(offsets) = self.offsets.get(segment_index) else {
            return Vec::new();
        };
        let segment_time = source_time as f32;
        let (camera_request_time, _) = segment_timing::segment_frame_times(
            segment_time,
            timing.latest_start_time.unwrap_or(0.0),
            *offsets,
        );
        let display_time = segment_time + timing.screen_offset as f32;
        let camera_time = timing.camera_fps.map_or(f64::NAN, |_| {
            (camera_request_time + timing.camera_offset as f32) as f64
        });
        vec![display_time as f64, camera_time]
    }

    pub fn audio_times(&self, segment_index: usize, source_time: f64) -> Vec<f64> {
        if !source_time.is_finite() {
            return Vec::new();
        }
        let Some(offsets) = self.offsets.get(segment_index) else {
            return Vec::new();
        };
        let Some(present) = self.audio_present.get(segment_index) else {
            return Vec::new();
        };
        let source_time = source_time as f32;
        vec![
            if present[0] {
                (source_time + offsets.mic) as f64
            } else {
                f64::NAN
            },
            if present[1] {
                (source_time + offsets.system_audio) as f64
            } else {
                f64::NAN
            },
        ]
    }
}

struct InputTexture {
    texture: wgpu::Texture,
    uniform_buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    width: u32,
    height: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct BackgroundUniforms {
    start: [f32; 4],
    end: [f32; 4],
    angle: f32,
    noise_intensity: f32,
    noise_scale: f32,
    padding: f32,
}

impl BackgroundUniforms {
    fn from_source(source: &BackgroundSource) -> Result<Self, JsValue> {
        let color = |value: &[u16; 3], alpha: f32| {
            [
                value[0] as f32 / 255.0 * alpha,
                value[1] as f32 / 255.0 * alpha,
                value[2] as f32 / 255.0 * alpha,
                alpha,
            ]
        };
        match source {
            BackgroundSource::Color { value, alpha } => {
                let rgba = color(value, *alpha as f32 / 255.0);
                Ok(Self {
                    start: rgba,
                    end: rgba,
                    angle: 0.0,
                    noise_intensity: 0.0,
                    noise_scale: 0.0,
                    padding: 0.0,
                })
            }
            BackgroundSource::Gradient {
                from,
                to,
                angle,
                noise_intensity,
                noise_scale,
                ..
            } => Ok(Self {
                start: color(from, 1.0),
                end: color(to, 1.0),
                angle: *angle as f32,
                noise_intensity: noise_intensity.unwrap_or(0.0),
                noise_scale: noise_scale.unwrap_or(3.0),
                padding: 0.0,
            }),
            BackgroundSource::Wallpaper { .. }
            | BackgroundSource::Image { .. }
            | BackgroundSource::AnimatedGradient { .. } => Err(js_error(
                "This editor background needs a browser image layer",
            )),
        }
    }
}

struct BrowserBackground {
    pipeline: wgpu::RenderPipeline,
    buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

impl BrowserBackground {
    fn new(
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
        uniforms: BackgroundUniforms,
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared editor background shader"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../../../../crates/rendering/src/shaders/gradient-or-color.wgsl")
                    .into(),
            ),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Browser editor background layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Browser editor background pipeline layout"),
            bind_group_layouts: &[&layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Browser editor background pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: Some(wgpu::Face::Back),
                ..Default::default()
            },
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Browser editor background uniforms"),
            contents: bytemuck::bytes_of(&uniforms),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Browser editor background bind group"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: buffer.as_entire_binding(),
            }],
        });
        Self {
            pipeline,
            buffer,
            bind_group,
        }
    }

    fn update(&self, queue: &wgpu::Queue, uniforms: BackgroundUniforms) {
        queue.write_buffer(&self.buffer, 0, bytemuck::bytes_of(&uniforms));
    }

    fn draw(&self, pass: &mut wgpu::RenderPass<'_>) {
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.draw(0..4, 0..1);
    }
}

struct BrowserBlurredBackground {
    background: wgpu::Texture,
    horizontal: wgpu::Texture,
    dirty: Cell<bool>,
    blit_bind_group: wgpu::BindGroup,
    surface_pipeline: wgpu::RenderPipeline,
    intermediate_pipeline: Option<wgpu::RenderPipeline>,
}

impl BrowserBlurredBackground {
    fn new(
        device: &wgpu::Device,
        width: u32,
        height: u32,
        surface_format: wgpu::TextureFormat,
    ) -> Self {
        let make_texture = |label| {
            device.create_texture(&wgpu::TextureDescriptor {
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
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
        };
        let background = make_texture("Browser blurred background");
        let horizontal = make_texture("Browser horizontal background blur");
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Browser blurred background blit layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }],
        });
        let blit_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Browser blurred background blit"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(
                    &background.create_view(&wgpu::TextureViewDescriptor::default()),
                ),
            }],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared browser background blit shader"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../../../../crates/rendering/src/shaders/blit_bgra_surface.wgsl")
                    .into(),
            ),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Browser blurred background blit pipeline layout"),
            bind_group_layouts: &[&layout],
            push_constant_ranges: &[],
        });
        let make_pipeline = |format| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Browser blurred background blit"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: Some(wgpu::BlendState::REPLACE),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: Some(wgpu::Face::Back),
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: Default::default(),
                multiview: None,
                cache: None,
            })
        };
        Self {
            background,
            horizontal,
            dirty: Cell::new(true),
            blit_bind_group,
            surface_pipeline: make_pipeline(surface_format),
            intermediate_pipeline: (surface_format != wgpu::TextureFormat::Rgba8Unorm)
                .then(|| make_pipeline(wgpu::TextureFormat::Rgba8Unorm)),
        }
    }

    fn draw(&self, pass: &mut wgpu::RenderPass<'_>, intermediate: bool) {
        pass.set_pipeline(if intermediate {
            self.intermediate_pipeline
                .as_ref()
                .unwrap_or(&self.surface_pipeline)
        } else {
            &self.surface_pipeline
        });
        pass.set_bind_group(0, &self.blit_bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct ImageBackgroundUniforms {
    output_size: [f32; 2],
    padding: f32,
    x_width: f32,
    y_height: f32,
    _padding: f32,
    _padding2: [f32; 2],
}

struct BrowserImageBackground {
    path: String,
    image_width: u32,
    image_height: u32,
    surface_pipeline: wgpu::RenderPipeline,
    intermediate_pipeline: Option<wgpu::RenderPipeline>,
    uniform_buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    _texture: wgpu::Texture,
}

impl BrowserImageBackground {
    fn uniforms(
        image_width: u32,
        image_height: u32,
        output_width: u32,
        output_height: u32,
    ) -> ImageBackgroundUniforms {
        let output_ar = output_height as f32 / output_width as f32;
        let image_ar = image_height as f32 / image_width as f32;
        let y_height = if output_ar < image_ar {
            ((image_ar - output_ar) / 2.0) / image_ar
        } else {
            0.0
        };
        let x_width = if output_ar > image_ar {
            let output_ar = 1.0 / output_ar;
            let image_ar = 1.0 / image_ar;
            ((image_ar - output_ar) / 2.0) / image_ar
        } else {
            0.0
        };
        ImageBackgroundUniforms {
            output_size: [output_width as f32, output_height as f32],
            padding: 0.0,
            x_width,
            y_height,
            _padding: 0.0,
            _padding2: [0.0; 2],
        }
    }

    fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        surface_format: wgpu::TextureFormat,
        output_width: u32,
        output_height: u32,
        path: String,
        image: ImageBitmap,
    ) -> Result<Self, JsValue> {
        let image_width = image.width();
        let image_height = image.height();
        if image_width == 0
            || image_height == 0
            || image_width > device.limits().max_texture_dimension_2d
            || image_height > device.limits().max_texture_dimension_2d
        {
            return Err(js_error(
                "Editor background image exceeds browser GPU limits",
            ));
        }
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Shared editor image background shader"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../../../../crates/rendering/src/shaders/image-background.wgsl")
                    .into(),
            ),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Browser image background layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
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
            label: Some("Browser image background pipeline layout"),
            bind_group_layouts: &[&layout],
            push_constant_ranges: &[],
        });
        let make_pipeline = |format| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Browser editor image background pipeline"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: Some(wgpu::BlendState::REPLACE),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: Some(wgpu::Face::Back),
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: Default::default(),
                multiview: None,
                cache: None,
            })
        };
        let surface_pipeline = make_pipeline(surface_format);
        let intermediate_pipeline = (surface_format != wgpu::TextureFormat::Rgba8Unorm)
            .then(|| make_pipeline(wgpu::TextureFormat::Rgba8Unorm));
        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Browser image background uniforms"),
            contents: bytemuck::bytes_of(&Self::uniforms(
                image_width,
                image_height,
                output_width,
                output_height,
            )),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Browser editor background image"),
            size: wgpu::Extent3d {
                width: image_width,
                height: image_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        queue.copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo {
                source: wgpu::ExternalImageSource::ImageBitmap(image),
                origin: wgpu::Origin2d::ZERO,
                flip_y: false,
            },
            wgpu::CopyExternalImageDestInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb,
                premultiplied_alpha: false,
            },
            wgpu::Extent3d {
                width: image_width,
                height: image_height,
                depth_or_array_layers: 1,
            },
        );
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Browser editor image background bind group"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &texture.create_view(&wgpu::TextureViewDescriptor::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        Ok(Self {
            path,
            image_width,
            image_height,
            surface_pipeline,
            intermediate_pipeline,
            uniform_buffer,
            bind_group,
            _texture: texture,
        })
    }

    fn update_size(&self, queue: &wgpu::Queue, output_width: u32, output_height: u32) {
        queue.write_buffer(
            &self.uniform_buffer,
            0,
            bytemuck::bytes_of(&Self::uniforms(
                self.image_width,
                self.image_height,
                output_width,
                output_height,
            )),
        );
    }

    fn draw(&self, pass: &mut wgpu::RenderPass<'_>, intermediate: bool) {
        let pipeline = if intermediate {
            self.intermediate_pipeline
                .as_ref()
                .unwrap_or(&self.surface_pipeline)
        } else {
            &self.surface_pipeline
        };
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.draw(0..4, 0..1);
    }
}

fn create_input(
    device: &wgpu::Device,
    pipeline: &CompositeVideoFramePipeline,
    width: u32,
    height: u32,
) -> InputTexture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Browser decoded video frame"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_DST
            | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let uniform_buffer = CompositeVideoFrameUniforms::default().to_buffer(device);
    let bind_group = pipeline.bind_group(device, &uniform_buffer, &view);
    InputTexture {
        texture,
        uniform_buffer,
        bind_group,
        width,
        height,
    }
}

fn upload_video(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    pipeline: &CompositeVideoFramePipeline,
    stored: &mut Option<InputTexture>,
    video: HtmlVideoElement,
    uniform_bytes: &[u8],
    output_width: u32,
    output_height: u32,
) -> Result<(), JsValue> {
    let width = video.video_width();
    let height = video.video_height();
    if video.ready_state() < 2 || width == 0 || height == 0 {
        return Err(js_error("Video frame is not decoded"));
    }
    if width > device.limits().max_texture_dimension_2d
        || height > device.limits().max_texture_dimension_2d
    {
        return Err(js_error("Video exceeds the browser GPU texture limit"));
    }
    if stored
        .as_ref()
        .is_none_or(|input| input.width != width || input.height != height)
    {
        *stored = Some(create_input(device, pipeline, width, height));
    }
    let input = stored
        .as_ref()
        .ok_or_else(|| js_error("Video input is missing"))?;
    let mut uniforms: CompositeVideoFrameUniforms =
        bytemuck::try_pod_read_unaligned(uniform_bytes).map_err(js_error)?;
    uniforms.output_size = [output_width as f32, output_height as f32];
    uniforms.frame_size = [width as f32, height as f32];
    uniforms.write_to_buffer(queue, &input.uniform_buffer);
    queue.copy_external_image_to_texture(
        &wgpu::CopyExternalImageSourceInfo {
            source: wgpu::ExternalImageSource::HTMLVideoElement(video),
            origin: wgpu::Origin2d::ZERO,
            flip_y: false,
        },
        wgpu::CopyExternalImageDestInfo {
            texture: &input.texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
            color_space: wgpu::PredefinedColorSpace::Srgb,
            premultiplied_alpha: false,
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    Ok(())
}

fn render_background(
    pass: &mut wgpu::RenderPass<'_>,
    background: &BrowserBackground,
    animated_background: Option<&AnimatedGradientLayer>,
    image_background: Option<&BrowserImageBackground>,
    intermediate: bool,
) {
    if let Some(image_background) = image_background {
        image_background.draw(pass, intermediate);
    } else if let Some(animated_background) = animated_background {
        animated_background.render(pass);
    } else {
        background.draw(pass);
    }
}

type BrowserBlurInputs<'a> = (
    &'a BlurLayer,
    &'a BrowserBlurredBackground,
    &'a BrowserBackground,
    Option<&'a AnimatedGradientLayer>,
);

fn blur_inputs<'a>(
    layer: Option<&'a BlurLayer>,
    cached: Option<&'a BrowserBlurredBackground>,
    background: Option<&'a BrowserBackground>,
    animated: Option<&'a AnimatedGradientLayer>,
) -> Option<BrowserBlurInputs<'a>> {
    Some((layer?, cached?, background?, animated))
}

fn draw_layers(
    background: &BrowserBackground,
    animated_background: Option<&AnimatedGradientLayer>,
    image_background: Option<&BrowserImageBackground>,
    blur: Option<BrowserBlurInputs<'_>>,
    intermediate: bool,
    pipeline: &CompositeVideoFramePipeline,
    device: &wgpu::Device,
    encoder: &mut wgpu::CommandEncoder,
    target: &wgpu::TextureView,
    screen: &InputTexture,
    camera: Option<&InputTexture>,
) {
    if let Some((layer, cached, rgba_background, rgba_animated)) = blur
        && (cached.dirty.get() || rgba_animated.is_some())
    {
        let background_view = cached
            .background
            .create_view(&wgpu::TextureViewDescriptor::default());
        let horizontal_view = cached
            .horizontal
            .create_view(&wgpu::TextureViewDescriptor::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Browser editor background before blur"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &background_view,
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
            render_background(
                &mut pass,
                rgba_background,
                rgba_animated,
                image_background,
                true,
            );
        }
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Browser editor horizontal background blur"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &horizontal_view,
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
            layer.render_h(&mut pass, device, &background_view);
        }
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Browser editor vertical background blur"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &background_view,
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
            layer.render_v(&mut pass, device, &horizontal_view);
        }
        cached.dirty.set(false);
    }
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("Browser editor video layers"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
    });
    if let Some((_, cached, _, _)) = blur {
        cached.draw(&mut pass, intermediate);
    } else {
        render_background(
            &mut pass,
            background,
            animated_background,
            image_background,
            intermediate,
        );
    }
    pass.set_pipeline(&pipeline.render_pipeline);
    pass.set_bind_group(0, &screen.bind_group, &[]);
    pass.draw(0..3, 0..1);
    if let Some(camera) = camera {
        pass.set_bind_group(0, &camera.bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
}

#[derive(Clone, Copy)]
enum LastRenderedComposition {
    Single { has_camera: bool },
    Transition,
}

#[derive(Clone)]
struct StoredLayer {
    video: HtmlVideoElement,
    uniforms: Vec<u8>,
}

#[derive(Clone)]
enum StoredComposition {
    Single {
        screen: StoredLayer,
        camera: Option<StoredLayer>,
    },
    Transition,
}

#[wasm_bindgen]
pub struct BrowserGpuRenderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: CompositeVideoFramePipeline,
    background: BrowserBackground,
    background_blur: Option<BlurLayer>,
    blurred_background: Option<BrowserBlurredBackground>,
    background_key: Option<String>,
    background_uniforms: BackgroundUniforms,
    image_background: Option<BrowserImageBackground>,
    animated_background: Option<AnimatedGradientLayer>,
    animated_intermediate: Option<AnimatedGradientLayer>,
    animated_config: Option<AnimatedGradientConfig>,
    frame_number: u32,
    frame_rate: u32,
    intermediate_background: Option<BrowserBackground>,
    transition: Option<TransitionCompositor>,
    intermediate_pipeline: Option<CompositeVideoFramePipeline>,
    surface_config: wgpu::SurfaceConfiguration,
    backend: String,
    screen: Option<InputTexture>,
    camera: Option<InputTexture>,
    intermediate: Option<wgpu::Texture>,
    last_rendered: Option<LastRenderedComposition>,
    last_composition: Option<StoredComposition>,
}

fn draw_retained(
    renderer: &BrowserGpuRenderer,
    encoder: &mut wgpu::CommandEncoder,
    target: &wgpu::TextureView,
) -> Result<bool, JsValue> {
    let Some(last) = renderer.last_rendered else {
        return Ok(false);
    };
    match last {
        LastRenderedComposition::Single { has_camera } => {
            let screen = renderer
                .screen
                .as_ref()
                .ok_or_else(|| js_error("Retained display frame is missing"))?;
            draw_layers(
                &renderer.background,
                renderer.animated_background.as_ref(),
                renderer.image_background.as_ref(),
                blur_inputs(
                    renderer.background_blur.as_ref(),
                    renderer.blurred_background.as_ref(),
                    renderer.intermediate_background.as_ref(),
                    renderer.animated_intermediate.as_ref(),
                ),
                false,
                &renderer.pipeline,
                &renderer.device,
                encoder,
                target,
                screen,
                has_camera.then(|| renderer.camera.as_ref()).flatten(),
            );
        }
        LastRenderedComposition::Transition => {
            let transition = renderer
                .transition
                .as_ref()
                .ok_or_else(|| js_error("Retained transition is missing"))?;
            transition.render_cached(encoder, target);
        }
    }
    Ok(true)
}

#[wasm_bindgen]
impl BrowserGpuRenderer {
    #[wasm_bindgen(js_name = create)]
    pub async fn create(canvas: HtmlCanvasElement) -> Result<BrowserGpuRenderer, JsValue> {
        Self::create_with_backend(canvas, true).await
    }

    #[wasm_bindgen(js_name = createWebGl)]
    pub async fn create_webgl(canvas: HtmlCanvasElement) -> Result<BrowserGpuRenderer, JsValue> {
        Self::create_with_backend(canvas, false).await
    }

    async fn create_with_backend(
        canvas: HtmlCanvasElement,
        prefer_webgpu: bool,
    ) -> Result<BrowserGpuRenderer, JsValue> {
        let width = canvas.width().max(1);
        let height = canvas.height().max(1);
        let webgpu = if prefer_webgpu {
            Some(
                async {
                    trace_renderer("requesting WebGPU instance");
                    let instance =
                        wgpu::util::new_instance_with_webgpu_detection(&wgpu::InstanceDescriptor {
                            backends: wgpu::Backends::BROWSER_WEBGPU,
                            ..Default::default()
                        })
                        .await;
                    trace_renderer("requesting WebGPU adapter");
                    let adapter = instance
                        .request_adapter(&wgpu::RequestAdapterOptions {
                            power_preference: wgpu::PowerPreference::HighPerformance,
                            compatible_surface: None,
                            force_fallback_adapter: false,
                        })
                        .await
                        .map_err(js_error)?;
                    trace_renderer("requesting WebGPU device");
                    let limits = wgpu::Limits::downlevel_webgl2_defaults()
                        .using_resolution(adapter.limits());
                    let (device, queue) = adapter
                        .request_device(&wgpu::DeviceDescriptor {
                            required_limits: limits,
                            required_features: wgpu::Features::empty(),
                            ..Default::default()
                        })
                        .await
                        .map_err(js_error)?;
                    trace_renderer("creating WebGPU surface");
                    let surface = instance
                        .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
                        .map_err(js_error)?;
                    let surface_config = surface
                        .get_default_config(&adapter, width, height)
                        .ok_or_else(|| js_error("Browser canvas is not supported by this GPU"))?;
                    Ok::<_, JsValue>((surface, adapter, device, queue, surface_config))
                }
                .await,
            )
        } else {
            None
        };
        let (surface, adapter, device, queue, mut surface_config) = match webgpu {
            Some(Ok(value)) => value,
            Some(Err(_)) | None => {
                trace_renderer("requesting WebGL instance");
                let instance =
                    wgpu::util::new_instance_with_webgpu_detection(&wgpu::InstanceDescriptor {
                        backends: wgpu::Backends::GL,
                        ..Default::default()
                    })
                    .await;
                trace_renderer("creating WebGL surface");
                let surface = instance
                    .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
                    .map_err(js_error)?;
                let context: WebGl2RenderingContext = canvas
                    .get_context("webgl2")?
                    .ok_or_else(|| js_error("Browser WebGL2 is unavailable"))?
                    .dyn_into()
                    .map_err(|_| js_error("Browser WebGL2 context is invalid"))?;
                if context.is_context_lost() || context.get_supported_extensions().is_none() {
                    return Err(js_error("Browser WebGL2 context was lost"));
                }
                trace_renderer("requesting WebGL adapter");
                let adapter = instance
                    .request_adapter(&wgpu::RequestAdapterOptions {
                        power_preference: wgpu::PowerPreference::HighPerformance,
                        compatible_surface: Some(&surface),
                        force_fallback_adapter: false,
                    })
                    .await
                    .map_err(js_error)?;
                trace_renderer("requesting WebGL device");
                let limits =
                    wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits());
                let (device, queue) = adapter
                    .request_device(&wgpu::DeviceDescriptor {
                        required_limits: limits,
                        required_features: wgpu::Features::empty(),
                        ..Default::default()
                    })
                    .await
                    .map_err(js_error)?;
                trace_renderer("configuring WebGL surface");
                let surface_config = surface
                    .get_default_config(&adapter, width, height)
                    .ok_or_else(|| js_error("Browser canvas is not supported by this GPU"))?;
                trace_renderer("WebGL surface configured");
                (surface, adapter, device, queue, surface_config)
            }
        };
        let backend = format!("{:?}", adapter.get_info().backend);
        if adapter.get_info().backend != wgpu::Backend::BrowserWebGpu
            && surface
                .get_capabilities(&adapter)
                .formats
                .contains(&wgpu::TextureFormat::Rgba8Unorm)
        {
            surface_config.format = wgpu::TextureFormat::Rgba8Unorm;
        }
        trace_renderer(&format!("surface format {:?}", surface_config.format));
        surface_config.desired_maximum_frame_latency = 2;
        surface.configure(&device, &surface_config);
        let pipeline = CompositeVideoFramePipeline::new_for_format(&device, surface_config.format);
        let background_uniforms = BackgroundUniforms::from_source(&BackgroundSource::default())?;
        let background =
            BrowserBackground::new(&device, surface_config.format, background_uniforms);
        Ok(Self {
            surface,
            device,
            queue,
            pipeline,
            background,
            background_blur: None,
            blurred_background: None,
            background_key: None,
            background_uniforms,
            image_background: None,
            animated_background: None,
            animated_intermediate: None,
            animated_config: None,
            frame_number: 0,
            frame_rate: 60,
            intermediate_background: None,
            transition: None,
            intermediate_pipeline: None,
            surface_config,
            backend,
            screen: None,
            camera: None,
            intermediate: None,
            last_rendered: None,
            last_composition: None,
        })
    }

    #[wasm_bindgen(getter)]
    pub fn backend(&self) -> String {
        self.backend.clone()
    }

    pub fn set_background(
        &mut self,
        project_json: &str,
        image: Option<ImageBitmap>,
    ) -> Result<(), JsValue> {
        let project: ProjectConfiguration = serde_json::from_str(project_json).map_err(js_error)?;
        let background_key = serde_json::to_string(&project.background).map_err(js_error)?;
        let background_changed = self.background_key.as_ref() != Some(&background_key);
        match &project.background.source {
            BackgroundSource::AnimatedGradient { config } => {
                self.image_background = None;
                if self.animated_background.is_none() {
                    self.animated_background = Some(AnimatedGradientLayer::new_for_format(
                        &self.device,
                        config.clone(),
                        &self.project_uniforms(),
                        self.surface_config.format,
                    ));
                }
                self.animated_config = Some(config.clone());
            }
            BackgroundSource::Image { path } | BackgroundSource::Wallpaper { path } => {
                if let Some(path) = path.as_deref().filter(|path| !path.is_empty()) {
                    if self
                        .image_background
                        .as_ref()
                        .is_none_or(|background| background.path != path)
                    {
                        let image = image
                            .ok_or_else(|| js_error("Editor background image is unavailable"))?;
                        self.image_background = Some(BrowserImageBackground::new(
                            &self.device,
                            &self.queue,
                            self.surface_config.format,
                            self.surface_config.width,
                            self.surface_config.height,
                            path.to_owned(),
                            image,
                        )?);
                    }
                } else {
                    let white = BackgroundSource::Color {
                        value: [255, 255, 255],
                        alpha: 255,
                    };
                    let uniforms = BackgroundUniforms::from_source(&white)?;
                    self.background.update(&self.queue, uniforms);
                    self.intermediate_background
                        .as_ref()
                        .map(|background| background.update(&self.queue, uniforms));
                    self.background_uniforms = uniforms;
                    self.image_background = None;
                }
                self.animated_background = None;
                self.animated_intermediate = None;
                self.animated_config = None;
            }
            source => {
                let uniforms = BackgroundUniforms::from_source(source)?;
                self.background.update(&self.queue, uniforms);
                self.intermediate_background
                    .as_ref()
                    .map(|background| background.update(&self.queue, uniforms));
                self.background_uniforms = uniforms;
                self.image_background = None;
                self.animated_background = None;
                self.animated_intermediate = None;
                self.animated_config = None;
            }
        }
        if project.background.blur > 0.0 {
            if self.background_blur.is_none() {
                self.background_blur = Some(BlurLayer::new(&self.device));
            }
            if let Some(layer) = self.background_blur.as_mut() {
                layer.prepare_values(
                    &self.queue,
                    (self.surface_config.width, self.surface_config.height),
                    project.background.blur,
                );
            }
            if self.blurred_background.is_none() {
                self.blurred_background = Some(BrowserBlurredBackground::new(
                    &self.device,
                    self.surface_config.width,
                    self.surface_config.height,
                    self.surface_config.format,
                ));
            }
            if background_changed && let Some(cached) = self.blurred_background.as_ref() {
                cached.dirty.set(true);
            }
            if self.intermediate_background.is_none() {
                self.intermediate_background = Some(BrowserBackground::new(
                    &self.device,
                    wgpu::TextureFormat::Rgba8Unorm,
                    self.background_uniforms,
                ));
            }
            if let (None, Some(config)) = (
                self.animated_intermediate.as_ref(),
                self.animated_config.as_ref(),
            ) {
                self.animated_intermediate = Some(AnimatedGradientLayer::new(
                    &self.device,
                    config.clone(),
                    &self.project_uniforms(),
                ));
            }
        } else {
            self.blurred_background = None;
            self.background_blur = None;
        }
        self.background_key = Some(background_key);
        Ok(())
    }

    pub fn set_frame_time(&mut self, frame_number: u32, frame_rate: u32) -> Result<(), JsValue> {
        if frame_rate == 0 {
            return Err(js_error("Editor frame rate is invalid"));
        }
        self.frame_number = frame_number;
        self.frame_rate = frame_rate;
        Ok(())
    }

    fn project_uniforms(&self) -> ProjectUniforms {
        ProjectUniforms {
            output_size: (self.surface_config.width, self.surface_config.height),
            frame_number: self.frame_number,
            frame_rate: self.frame_rate,
        }
    }

    fn prepare_background(&mut self, encoder: &mut wgpu::CommandEncoder) {
        let project = self.project_uniforms();
        if let (Some(layer), Some(config)) = (
            self.animated_background.as_mut(),
            self.animated_config.as_ref(),
        ) {
            layer.prepare(&self.device, &self.queue, config.clone(), &project);
            layer.render_surface(encoder);
        }
        if let (Some(layer), Some(config)) = (
            self.animated_intermediate.as_mut(),
            self.animated_config.as_ref(),
        ) {
            layer.prepare(&self.device, &self.queue, config.clone(), &project);
            layer.render_surface(encoder);
        }
    }

    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), JsValue> {
        if width == 0
            || height == 0
            || width > self.device.limits().max_texture_dimension_2d
            || height > self.device.limits().max_texture_dimension_2d
        {
            return Err(js_error("Canvas size exceeds browser GPU limits"));
        }
        if width != self.surface_config.width || height != self.surface_config.height {
            self.surface_config.width = width;
            self.surface_config.height = height;
            self.surface.configure(&self.device, &self.surface_config);
            self.image_background
                .as_ref()
                .map(|background| background.update_size(&self.queue, width, height));
            if let Some(layer) = self.background_blur.as_mut() {
                layer.prepare_values(&self.queue, (width, height), layer.blur_amount);
                self.blurred_background = Some(BrowserBlurredBackground::new(
                    &self.device,
                    width,
                    height,
                    self.surface_config.format,
                ));
            }
            self.intermediate = None;
            self.last_rendered = None;
            self.last_composition = None;
        }
        Ok(())
    }

    pub fn render(
        &mut self,
        screen_video: HtmlVideoElement,
        screen_uniforms: &[u8],
        camera_video: Option<HtmlVideoElement>,
        camera_uniforms: Option<Vec<u8>>,
    ) -> Result<(), JsValue> {
        let output_width = self.surface_config.width;
        let output_height = self.surface_config.height;
        let has_camera = camera_video.is_some();
        let stored = StoredComposition::Single {
            screen: StoredLayer {
                video: screen_video.clone(),
                uniforms: screen_uniforms.to_vec(),
            },
            camera: camera_video
                .as_ref()
                .zip(camera_uniforms.as_ref())
                .map(|(video, uniforms)| StoredLayer {
                    video: video.clone(),
                    uniforms: uniforms.clone(),
                }),
        };
        if matches!(
            self.last_rendered,
            Some(LastRenderedComposition::Transition)
        ) {
            self.screen = None;
            self.camera = None;
        }
        upload_video(
            &self.device,
            &self.queue,
            &self.pipeline,
            &mut self.screen,
            screen_video,
            screen_uniforms,
            output_width,
            output_height,
        )?;
        if let Some(video) = camera_video {
            let uniforms = camera_uniforms
                .as_deref()
                .ok_or_else(|| js_error("Camera uniforms are missing"))?;
            upload_video(
                &self.device,
                &self.queue,
                &self.pipeline,
                &mut self.camera,
                video,
                uniforms,
                output_width,
                output_height,
            )?;
        }
        let frame = self.surface.get_current_texture().map_err(js_error)?;
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Browser editor composite"),
            });
        self.prepare_background(&mut encoder);
        let screen = self
            .screen
            .as_ref()
            .ok_or_else(|| js_error("Display frame is missing"))?;
        draw_layers(
            &self.background,
            self.animated_background.as_ref(),
            self.image_background.as_ref(),
            blur_inputs(
                self.background_blur.as_ref(),
                self.blurred_background.as_ref(),
                self.intermediate_background.as_ref(),
                self.animated_intermediate.as_ref(),
            ),
            false,
            &self.pipeline,
            &self.device,
            &mut encoder,
            &view,
            screen,
            has_camera.then(|| self.camera.as_ref()).flatten(),
        );
        self.queue.submit(Some(encoder.finish()));
        frame.present();
        self.last_rendered = Some(LastRenderedComposition::Single { has_camera });
        self.last_composition = Some(stored);
        Ok(())
    }

    pub fn render_transition(
        &mut self,
        outgoing_screen: HtmlVideoElement,
        outgoing_screen_uniforms: &[u8],
        outgoing_camera: Option<HtmlVideoElement>,
        outgoing_camera_uniforms: Option<Vec<u8>>,
        incoming_screen: HtmlVideoElement,
        incoming_screen_uniforms: &[u8],
        incoming_camera: Option<HtmlVideoElement>,
        incoming_camera_uniforms: Option<Vec<u8>>,
        kind: u32,
        progress: f32,
    ) -> Result<(), JsValue> {
        let transition_kind = match kind {
            0 => ClipTransitionType::CrossFade,
            1 => ClipTransitionType::FadeThroughBlack,
            _ => return Err(js_error("Transition type is invalid")),
        };
        if !progress.is_finite() {
            return Err(js_error("Transition progress is invalid"));
        }
        let output_width = self.surface_config.width;
        let output_height = self.surface_config.height;
        let outgoing_has_camera = outgoing_camera.is_some();
        let incoming_has_camera = incoming_camera.is_some();
        if matches!(
            self.last_rendered,
            Some(LastRenderedComposition::Single { .. })
        ) {
            self.screen = None;
            self.camera = None;
        }
        if self.intermediate.is_none() {
            self.intermediate = Some(self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Browser transition composition"),
                size: wgpu::Extent3d {
                    width: output_width,
                    height: output_height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            }));
        }
        if self.intermediate_pipeline.is_none() {
            self.intermediate_pipeline = Some(CompositeVideoFramePipeline::new(&self.device));
        }
        if let (None, Some(config)) = (
            self.animated_intermediate.as_ref(),
            self.animated_config.as_ref(),
        ) {
            self.animated_intermediate = Some(AnimatedGradientLayer::new(
                &self.device,
                config.clone(),
                &self.project_uniforms(),
            ));
        }
        if self.intermediate_background.is_none() {
            self.intermediate_background = Some(BrowserBackground::new(
                &self.device,
                wgpu::TextureFormat::Rgba8Unorm,
                self.background_uniforms,
            ));
        }
        if self.transition.is_none() {
            self.transition = Some(TransitionCompositor::new_for_format(
                &self.device,
                self.surface_config.format,
            ));
        }
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Browser editor transition"),
            });
        self.prepare_background(&mut encoder);
        let pipeline = self
            .intermediate_pipeline
            .as_ref()
            .ok_or_else(|| js_error("Transition pipeline is missing"))?;
        let intermediate = self
            .intermediate
            .as_ref()
            .ok_or_else(|| js_error("Transition canvas is missing"))?;
        let intermediate_view = intermediate.create_view(&wgpu::TextureViewDescriptor::default());
        let transition = self
            .transition
            .as_mut()
            .ok_or_else(|| js_error("Transition effect is missing"))?;
        transition.ensure_size(&self.device, output_width, output_height);
        upload_video(
            &self.device,
            &self.queue,
            pipeline,
            &mut self.screen,
            outgoing_screen,
            outgoing_screen_uniforms,
            output_width,
            output_height,
        )?;
        if let Some(video) = outgoing_camera {
            let uniforms = outgoing_camera_uniforms
                .as_deref()
                .ok_or_else(|| js_error("Outgoing camera uniforms are missing"))?;
            upload_video(
                &self.device,
                &self.queue,
                pipeline,
                &mut self.camera,
                video,
                uniforms,
                output_width,
                output_height,
            )?;
        }
        draw_layers(
            self.intermediate_background
                .as_ref()
                .ok_or_else(|| js_error("Transition background is missing"))?,
            self.animated_intermediate.as_ref(),
            self.image_background.as_ref(),
            blur_inputs(
                self.background_blur.as_ref(),
                self.blurred_background.as_ref(),
                self.intermediate_background.as_ref(),
                self.animated_intermediate.as_ref(),
            ),
            true,
            pipeline,
            &self.device,
            &mut encoder,
            &intermediate_view,
            self.screen
                .as_ref()
                .ok_or_else(|| js_error("Outgoing display is missing"))?,
            outgoing_has_camera.then(|| self.camera.as_ref()).flatten(),
        );
        transition.capture_outgoing(&mut encoder, intermediate);
        upload_video(
            &self.device,
            &self.queue,
            pipeline,
            &mut self.screen,
            incoming_screen,
            incoming_screen_uniforms,
            output_width,
            output_height,
        )?;
        if let Some(video) = incoming_camera {
            let uniforms = incoming_camera_uniforms
                .as_deref()
                .ok_or_else(|| js_error("Incoming camera uniforms are missing"))?;
            upload_video(
                &self.device,
                &self.queue,
                pipeline,
                &mut self.camera,
                video,
                uniforms,
                output_width,
                output_height,
            )?;
        }
        draw_layers(
            self.intermediate_background
                .as_ref()
                .ok_or_else(|| js_error("Transition background is missing"))?,
            self.animated_intermediate.as_ref(),
            self.image_background.as_ref(),
            blur_inputs(
                self.background_blur.as_ref(),
                self.blurred_background.as_ref(),
                self.intermediate_background.as_ref(),
                self.animated_intermediate.as_ref(),
            ),
            true,
            pipeline,
            &self.device,
            &mut encoder,
            &intermediate_view,
            self.screen
                .as_ref()
                .ok_or_else(|| js_error("Incoming display is missing"))?,
            incoming_has_camera.then(|| self.camera.as_ref()).flatten(),
        );
        let frame = self.surface.get_current_texture().map_err(js_error)?;
        let surface_view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        transition.capture_incoming_and_render(
            &self.queue,
            &mut encoder,
            intermediate,
            &surface_view,
            TransitionParameters {
                kind: transition_kind,
                progress,
                opaque: true,
            },
        );
        self.queue.submit(Some(encoder.finish()));
        frame.present();
        self.last_rendered = Some(LastRenderedComposition::Transition);
        self.last_composition = Some(StoredComposition::Transition);
        Ok(())
    }

    pub fn redraw_last(&mut self) -> Result<bool, JsValue> {
        if self.last_rendered.is_none() {
            return Ok(false);
        }
        let frame = self.surface.get_current_texture().map_err(js_error)?;
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Browser editor retained composition"),
            });
        self.prepare_background(&mut encoder);
        draw_retained(self, &mut encoder, &view)?;
        self.queue.submit(Some(encoder.finish()));
        frame.present();
        Ok(true)
    }

    pub async fn snapshot_rgba(&mut self) -> Result<Vec<u8>, JsValue> {
        let stored = self
            .last_composition
            .clone()
            .ok_or_else(|| js_error("No editor frame has been rendered"))?;
        let width = self.surface_config.width;
        let height = self.surface_config.height;
        let pixel_bytes = width as u64 * height as u64 * 4;
        if pixel_bytes > 64 * 1024 * 1024 {
            return Err(js_error("Editor snapshot exceeds the browser memory limit"));
        }
        let row_bytes = (width * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Editor snapshot texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.surface_config.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Editor snapshot readback"),
            size: row_bytes as u64 * height as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Editor snapshot readback"),
            });
        self.prepare_background(&mut encoder);
        match stored {
            StoredComposition::Single { screen, camera } => {
                upload_video(
                    &self.device,
                    &self.queue,
                    &self.pipeline,
                    &mut self.screen,
                    screen.video,
                    &screen.uniforms,
                    width,
                    height,
                )?;
                if let Some(camera) = &camera {
                    upload_video(
                        &self.device,
                        &self.queue,
                        &self.pipeline,
                        &mut self.camera,
                        camera.video.clone(),
                        &camera.uniforms,
                        width,
                        height,
                    )?;
                }
                draw_layers(
                    &self.background,
                    self.animated_background.as_ref(),
                    self.image_background.as_ref(),
                    blur_inputs(
                        self.background_blur.as_ref(),
                        self.blurred_background.as_ref(),
                        self.intermediate_background.as_ref(),
                        self.animated_intermediate.as_ref(),
                    ),
                    false,
                    &self.pipeline,
                    &self.device,
                    &mut encoder,
                    &view,
                    self.screen
                        .as_ref()
                        .ok_or_else(|| js_error("Display frame is missing"))?,
                    camera.as_ref().and(self.camera.as_ref()),
                );
            }
            StoredComposition::Transition => {
                draw_retained(self, &mut encoder, &view)?;
            }
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row_bytes),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(Some(encoder.finish()));
        let (sender, mut receiver) = futures_channel::oneshot::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |status| {
                let _ = sender.send(status);
            });
        let mut mapped = false;
        for _ in 0..500 {
            self.device.poll(wgpu::PollType::Poll).map_err(js_error)?;
            if let Some(status) = receiver.try_recv().map_err(js_error)? {
                status.map_err(js_error)?;
                mapped = true;
                break;
            }
            wait_for_gpu_poll().await?;
        }
        if !mapped {
            return Err(js_error("Editor snapshot GPU readback timed out"));
        }
        let mapped = buffer.slice(..).get_mapped_range();
        let mut pixels = vec![0; pixel_bytes as usize];
        for row in 0..height as usize {
            let source = row * row_bytes as usize;
            let destination = row * width as usize * 4;
            pixels[destination..destination + width as usize * 4]
                .copy_from_slice(&mapped[source..source + width as usize * 4]);
        }
        drop(mapped);
        buffer.unmap();
        if matches!(
            self.surface_config.format,
            wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb
        ) {
            for pixel in pixels.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
        }
        Ok(pixels)
    }
}

#[wasm_bindgen]
pub fn default_layer_uniforms(
    output_width: u32,
    output_height: u32,
    source_width: u32,
    source_height: u32,
    camera: bool,
) -> Vec<u8> {
    let mut uniforms = CompositeVideoFrameUniforms {
        crop_bounds: [0.0, 0.0, source_width as f32, source_height as f32],
        output_size: [output_width as f32, output_height as f32],
        frame_size: [source_width as f32, source_height as f32],
        ..Default::default()
    };
    if camera {
        let size = output_height as f32 * 0.25;
        let margin = output_height as f32 * 0.04;
        let left = output_width as f32 - size - margin;
        let top = output_height as f32 - size - margin;
        uniforms.target_bounds = [left, top, left + size, top + size];
        uniforms.target_size = [size, size];
        uniforms.rounding_px = size * 0.5;
    } else {
        uniforms.target_bounds = [0.0, 0.0, output_width as f32, output_height as f32];
        uniforms.target_size = [output_width as f32, output_height as f32];
    }
    bytemuck::bytes_of(&uniforms).to_vec()
}

#[wasm_bindgen]
pub struct BrowserVisualConfig {
    project: ProjectConfiguration,
}

#[wasm_bindgen]
impl BrowserVisualConfig {
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str) -> Result<Self, JsValue> {
        Ok(Self {
            project: serde_json::from_str(config_json).map_err(js_error)?,
        })
    }

    pub fn output_dimensions(
        &self,
        source_width: u32,
        source_height: u32,
        resolution_width: u32,
        resolution_height: u32,
    ) -> Result<Vec<u32>, JsValue> {
        if source_width == 0
            || source_height == 0
            || resolution_width == 0
            || resolution_height == 0
        {
            return Err(js_error("Editor output dimensions are invalid"));
        }
        let crop = self.project.background.crop.as_ref();
        let crop_width = crop.map_or(source_width, |value| value.size.x);
        let crop_height = crop.map_or(source_height, |value| value.size.y);
        if crop_width == 0 || crop_height == 0 {
            return Err(js_error("Editor crop dimensions are invalid"));
        }
        let padding_factor = self.project.background.padding / 100.0 * 0.4;
        let base_size = match &self.project.aspect_ratio {
            None => {
                let scale = 1.0 + padding_factor * 2.0;
                (
                    (((crop_width as f64 * scale) as u32 + 1) & !1).max(2),
                    (((crop_height as f64 * scale) as u32 + 1) & !1).max(2),
                )
            }
            Some(aspect) => {
                let target_aspect = match aspect {
                    AspectRatio::Square => 1.0,
                    AspectRatio::Wide => 16.0 / 9.0,
                    AspectRatio::Vertical => 9.0 / 16.0,
                    AspectRatio::Classic => 4.0 / 3.0,
                    AspectRatio::Tall => 3.0 / 4.0,
                };
                let crop_aspect = crop_width as f64 / crop_height as f64;
                let padding = f64::from(crop_width.max(crop_height)) * padding_factor * 2.0;
                let (width, height) = if crop_aspect > target_aspect {
                    let width = crop_width as f64 + padding;
                    (width, width / target_aspect)
                } else {
                    let height = crop_height as f64 + padding;
                    (height * target_aspect, height)
                };
                (
                    (((width.ceil() as u32) + 1) & !1).max(2),
                    (((height.ceil() as u32) + 1) & !1).max(2),
                )
            }
        };
        let width_scale = resolution_width as f32 / base_size.0 as f32;
        let height_scale = resolution_height as f32 / base_size.1 as f32;
        let scale = width_scale.min(height_scale);
        Ok(vec![
            ((base_size.0 as f32 * scale) as u32 + 3) & !3,
            ((base_size.1 as f32 * scale) as u32 + 1) & !1,
        ])
    }

    pub fn layer_uniforms(
        &self,
        output_width: u32,
        output_height: u32,
        source_width: u32,
        source_height: u32,
        camera: bool,
        frame_number: u32,
    ) -> Result<Vec<u8>, JsValue> {
        if output_width == 0 || output_height == 0 || source_width == 0 || source_height == 0 {
            return Err(js_error("Editor layer dimensions are invalid"));
        }
        let mut uniforms = CompositeVideoFrameUniforms {
            output_size: [output_width as f32, output_height as f32],
            frame_size: [source_width as f32, source_height as f32],
            crop_bounds: [0.0, 0.0, source_width as f32, source_height as f32],
            ..Default::default()
        };
        if camera {
            if self.project.camera.hide {
                uniforms.opacity = 0.0;
            }
            let output = [output_width as f32, output_height as f32];
            let min_axis = output[0].min(output[1]);
            let padding = 50.0 * output[1] / 1080.0;
            let base_size = self.project.camera.size / 100.0;
            let source_aspect = source_width as f32 / source_height as f32;
            let size = match self.project.camera.shape {
                CameraShape::Square => {
                    let side = min_axis * base_size + padding;
                    [side, side]
                }
                CameraShape::Source if source_aspect >= 1.0 => {
                    let height = min_axis * base_size + padding;
                    [height * source_aspect, height]
                }
                CameraShape::Source => {
                    let width = min_axis * base_size + padding;
                    [width, width / source_aspect]
                }
            };
            let position = if let Some(manual) = self.project.camera.manual_position {
                [
                    (manual.x as f32 * output[0] - size[0] / 2.0)
                        .clamp(0.0, (output[0] - size[0]).max(0.0)),
                    (manual.y as f32 * output[1] - size[1] / 2.0)
                        .clamp(0.0, (output[1] - size[1]).max(0.0)),
                ]
            } else {
                let x = match self.project.camera.position.x {
                    CameraXPosition::Left => padding,
                    CameraXPosition::Center => output[0] / 2.0 - size[0] / 2.0,
                    CameraXPosition::Right => output[0] - padding - size[0],
                };
                let y = match self.project.camera.position.y {
                    CameraYPosition::Top => padding,
                    CameraYPosition::Bottom => output[1] - padding - size[1],
                };
                [x, y]
            };
            uniforms.target_bounds = [
                position[0].round(),
                position[1].round(),
                (position[0] + size[0]).round(),
                (position[1] + size[1]).round(),
            ];
            uniforms.target_size = [
                uniforms.target_bounds[2] - uniforms.target_bounds[0],
                uniforms.target_bounds[3] - uniforms.target_bounds[1],
            ];
            if matches!(self.project.camera.shape, CameraShape::Square) {
                let source_size = source_width.min(source_height) as f32;
                let inset = (2.0 / source_size).min(0.25);
                let left = (source_width as f32 - source_size) * 0.5;
                let top = (source_height as f32 - source_size) * 0.5;
                uniforms.crop_bounds = [
                    left + source_size * inset,
                    top + source_size * inset,
                    left + source_size * (1.0 - inset),
                    top + source_size * (1.0 - inset),
                ];
            }
            uniforms.rounding_px = self.project.camera.rounding / 100.0
                * 0.5
                * uniforms.target_size[0].min(uniforms.target_size[1]);
            uniforms.rounding_type = match self.project.camera.rounding_type {
                CornerStyle::Rounded => 0.0,
                CornerStyle::Squircle => 1.0,
            };
            uniforms.mirror_x = if self.project.camera.mirror { 1.0 } else { 0.0 };
            uniforms.shadow = self.project.camera.shadow;
            let shadow = self.project.camera.advanced_shadow.as_ref();
            uniforms.shadow_size = shadow.map_or(50.0, |value| value.size);
            uniforms.shadow_opacity = shadow.map_or(18.0, |value| value.opacity);
            uniforms.shadow_blur = shadow.map_or(50.0, |value| value.blur);
        } else {
            let crop = self.project.background.crop.as_ref();
            let crop_width = crop.map_or(source_width, |value| value.size.x).max(1);
            let crop_height = crop.map_or(source_height, |value| value.size.y).max(1);
            let crop_x = crop.map_or(0, |value| value.position.x);
            let crop_y = crop.map_or(0, |value| value.position.y);
            uniforms.crop_bounds = [
                crop_x as f32,
                crop_y as f32,
                (crop_x + crop_width) as f32,
                (crop_y + crop_height) as f32,
            ];
            let pad_factor = self.project.background.padding / 100.0 * 0.4;
            let crop_w = crop_width as f64;
            let crop_h = crop_height as f64;
            let output_w = output_width as f64;
            let output_h = output_height as f64;
            let (base_w, base_h) = match &self.project.aspect_ratio {
                None => {
                    let scale = 1.0 + pad_factor * 2.0;
                    (
                        ((crop_w * scale) as u32 + 1) & !1,
                        ((crop_h * scale) as u32 + 1) & !1,
                    )
                }
                Some(aspect_ratio) => {
                    let aspect = match aspect_ratio {
                        AspectRatio::Wide => 16.0 / 9.0,
                        AspectRatio::Vertical => 9.0 / 16.0,
                        AspectRatio::Square => 1.0,
                        AspectRatio::Classic => 4.0 / 3.0,
                        AspectRatio::Tall => 3.0 / 4.0,
                    };
                    let padding = crop_w.max(crop_h) * pad_factor * 2.0;
                    let (width, height) = if crop_w / crop_h > aspect {
                        let width = crop_w + padding;
                        (width, width / aspect)
                    } else {
                        let height = crop_h + padding;
                        (height * aspect, height)
                    };
                    (
                        (((width.ceil() as u32) + 1) & !1).max(2),
                        (((height.ceil() as u32) + 1) & !1).max(2),
                    )
                }
            };
            let output_scale =
                (output_w / base_w.max(1) as f64).min(output_h / base_h.max(1) as f64);
            let (offset_x, offset_y) = if self.project.aspect_ratio.is_none() {
                (
                    crop_w * pad_factor * output_scale,
                    crop_h * pad_factor * output_scale,
                )
            } else {
                let max_padding = ((output_w - 1.0) / 2.0)
                    .min((output_h - 1.0) / 2.0)
                    .max(0.0);
                let padding = (crop_w.max(crop_h) * pad_factor * output_scale).min(max_padding);
                let available_w = (output_w - padding * 2.0).max(1.0);
                let available_h = (output_h - padding * 2.0).max(1.0);
                if crop_w / crop_h <= output_w / output_h {
                    ((output_w - available_h * crop_w / crop_h) / 2.0, padding)
                } else {
                    (padding, (output_h - available_w * crop_h / crop_w) / 2.0)
                }
            };
            let shift = self
                .project
                .background
                .display_position
                .map_or([0.0, 0.0], |position| {
                    [
                        (position.x.clamp(0.0, 1.0) - 0.5) * output_w,
                        (position.y.clamp(0.0, 1.0) - 0.5) * output_h,
                    ]
                });
            uniforms.target_bounds = [
                (offset_x + shift[0]) as f32,
                (offset_y + shift[1]) as f32,
                (output_w - offset_x + shift[0]) as f32,
                (output_h - offset_y + shift[1]) as f32,
            ];
            uniforms.target_size = [
                uniforms.target_bounds[2] - uniforms.target_bounds[0],
                uniforms.target_bounds[3] - uniforms.target_bounds[1],
            ];
            uniforms.rounding_px = self.project.background.rounding as f32 / 100.0
                * 0.5
                * uniforms.target_size[0].min(uniforms.target_size[1]);
            uniforms.rounding_type = match self.project.background.rounding_type {
                CornerStyle::Rounded => 0.0,
                CornerStyle::Squircle => 1.0,
            };
            uniforms.shadow = self.project.background.shadow;
            let shadow = self.project.background.advanced_shadow.as_ref();
            uniforms.shadow_size = shadow.map_or(50.0, |value| value.size);
            uniforms.shadow_opacity = shadow.map_or(18.0, |value| value.opacity);
            uniforms.shadow_blur = shadow.map_or(50.0, |value| value.blur);
            if let Some(border) = self.project.background.border.as_ref() {
                uniforms.border_enabled = if border.enabled { 1.0 } else { 0.0 };
                uniforms.border_width = border.width;
                uniforms.border_color = [
                    border.color[0] as f32 / 255.0,
                    border.color[1] as f32 / 255.0,
                    border.color[2] as f32 / 255.0,
                    border.opacity / 100.0,
                ];
            }
        }
        let grade = ColorGradeUniformParams::from_config(
            if camera {
                &self.project.color_correction.camera
            } else {
                &self.project.color_correction.screen
            },
            frame_number,
            false,
        );
        uniforms.color_adjust_a = grade.color_adjust_a;
        uniforms.color_adjust_b = grade.color_adjust_b;
        uniforms.grain_params = grade.grain_params;
        Ok(bytemuck::bytes_of(&uniforms).to_vec())
    }
}
