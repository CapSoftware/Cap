mod blur_pipeline;
mod segmentation;

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use blur_pipeline::{BlurPassInputs, BlurPipeline, CompositePipeline};
use segmentation::SegmentationModel;

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
pub fn onnx_runtime_library_path() -> Option<std::path::PathBuf> {
    segmentation::onnx_runtime_library_path()
}

pub fn initialize_onnx_runtime() -> anyhow::Result<()> {
    segmentation::init_runtime()
}

static BLUR_DISABLED: AtomicBool = AtomicBool::new(false);
static BLUR_SESSION_OBSERVER: OnceLock<fn(bool)> = OnceLock::new();

/// Globally disables camera background blur: `BlurProcessor::new` fails fast and
/// every call site degrades to its unblurred fallback. Set by the desktop app's
/// crash recovery when a previous session died with the blur pipeline active
/// (native DirectML/driver crashes never reach a panic handler).
pub fn set_blur_disabled(disabled: bool) {
    BLUR_DISABLED.store(disabled, Ordering::Release);
}

pub fn blur_disabled() -> bool {
    BLUR_DISABLED.load(Ordering::Acquire)
}

/// Registers a callback invoked with `true` while any `BlurProcessor` exists
/// (from just before the ONNX/GPU session is created until drop), so a host can
/// attribute a hard process death to the blur pipeline. Processes that never
/// register (cap-exporter, the CLI) get a no-op and unchanged behavior.
pub fn set_blur_session_observer(observer: fn(bool)) {
    let _ = BLUR_SESSION_OBSERVER.set(observer);
}

fn notify_blur_session(active: bool) {
    if let Some(observer) = BLUR_SESSION_OBSERVER.get() {
        observer(active);
    }
}

/// Pairs the observer's `true` notification with exactly one `false`, whether
/// init fails, init panics, or the processor is eventually dropped. Declared as
/// the LAST field of `BlurProcessor` so the disarm runs only after the ONNX
/// session and GPU resources have finished their own (native, crashable)
/// teardown.
struct BlurSessionHandle;

impl Drop for BlurSessionHandle {
    fn drop(&mut self) {
        notify_blur_session(false);
    }
}

const READBACK_PENDING: u8 = 0;
const READBACK_READY_OK: u8 = 1;
const READBACK_READY_ERR: u8 = 2;

enum ReadbackState {
    Idle,
    InFlight {
        status: Arc<AtomicU8>,
        submitted_at: Instant,
        dimensions: (u32, u32),
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlurMode {
    Light,
    Heavy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlurFailure {
    Inference(String),
    Readback(String),
    InvalidMask {
        expected_samples: usize,
        actual_samples: usize,
    },
    NonFiniteMask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlurMaskReceipt {
    pub generation: u64,
    /// Processing submission time, not the camera's original capture timestamp.
    pub input_submitted_at: Instant,
    pub inference_completed_at: Instant,
    pub input_dimensions: (u32, u32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlurMaskStatus {
    Pending,
    Ready(BlurMaskReceipt),
    Failed(BlurFailure),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlurOutputStatus {
    pub mode: BlurMode,
    pub output_sequence: u64,
    pub output_dimensions: (u32, u32),
    pub mask: BlurMaskStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppliedBlur {
    pub mode: BlurMode,
    pub output_sequence: u64,
    pub output_dimensions: (u32, u32),
    pub mask: BlurMaskReceipt,
    pub mask_age: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlurOutputUnavailable {
    Pending,
    Failed(BlurFailure),
    Stale {
        mask_age: Duration,
        max_mask_age: Duration,
    },
    MaskGeometryMismatch,
    InvalidTimestamp,
}

impl BlurOutputStatus {
    pub fn applied_at(
        &self,
        now: Instant,
        max_mask_age: Duration,
    ) -> Result<AppliedBlur, BlurOutputUnavailable> {
        let mask = match &self.mask {
            BlurMaskStatus::Pending => return Err(BlurOutputUnavailable::Pending),
            BlurMaskStatus::Failed(error) => {
                return Err(BlurOutputUnavailable::Failed(error.clone()));
            }
            BlurMaskStatus::Ready(mask) => *mask,
        };
        if mask.input_dimensions != self.output_dimensions {
            return Err(BlurOutputUnavailable::MaskGeometryMismatch);
        }
        if mask.input_submitted_at > mask.inference_completed_at
            || now < mask.inference_completed_at
        {
            return Err(BlurOutputUnavailable::InvalidTimestamp);
        }
        let mask_age = now.saturating_duration_since(mask.input_submitted_at);
        if mask_age > max_mask_age {
            return Err(BlurOutputUnavailable::Stale {
                mask_age,
                max_mask_age,
            });
        }
        Ok(AppliedBlur {
            mode: self.mode,
            output_sequence: self.output_sequence,
            output_dimensions: self.output_dimensions,
            mask,
            mask_age,
        })
    }
}

struct MaskStatusTracker {
    generation: u64,
    failure_revision: u64,
    status: BlurMaskStatus,
}

impl Default for MaskStatusTracker {
    fn default() -> Self {
        Self {
            generation: 0,
            failure_revision: 0,
            status: BlurMaskStatus::Pending,
        }
    }
}

impl MaskStatusTracker {
    fn reset(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.failure_revision = self.failure_revision.wrapping_add(1);
        self.status = BlurMaskStatus::Pending;
    }

    fn fail(&mut self, failure: BlurFailure) {
        self.failure_revision = self.failure_revision.wrapping_add(1);
        self.status = BlurMaskStatus::Failed(failure);
    }

    fn complete(
        &mut self,
        failure_revision: u64,
        submitted_at: Instant,
        dimensions: (u32, u32),
        now: Instant,
    ) {
        if self.failure_revision != failure_revision {
            return;
        }
        self.generation = self.generation.wrapping_add(1);
        self.status = BlurMaskStatus::Ready(BlurMaskReceipt {
            generation: self.generation,
            input_submitted_at: submitted_at,
            inference_completed_at: now,
            input_dimensions: dimensions,
        });
    }
}

fn validate_mask_samples(mask: &[f32], expected_samples: usize) -> Result<(), BlurFailure> {
    if mask.len() < expected_samples {
        return Err(BlurFailure::InvalidMask {
            expected_samples,
            actual_samples: mask.len(),
        });
    }
    if mask
        .iter()
        .take(expected_samples)
        .any(|value| !value.is_finite())
    {
        return Err(BlurFailure::NonFiniteMask);
    }
    Ok(())
}

struct ReadbackFrame {
    pixels: Vec<u8>,
    submitted_at: Instant,
    dimensions: (u32, u32),
}

const SEGMENTATION_SIZE: u32 = 256;
const DEFAULT_INFERENCE_INTERVAL: Duration = Duration::from_millis(66);
const MASK_GROWTH_ALPHA: f32 = 0.25;
const MASK_SHRINK_ALPHA: f32 = 0.12;
const MASK_STABILITY_EPSILON: f32 = 0.025;
const MASK_EDGE_CONTRAST: f32 = 4.0;
const INITIAL_MASK_VALUE: f32 = 1.0;

fn reset_mask_buffers(buffers: [&mut [f32]; 4]) {
    for buffer in buffers {
        buffer.fill(INITIAL_MASK_VALUE);
    }
}

pub struct BlurProcessor {
    model: SegmentationModel,
    blur_pipeline: BlurPipeline,
    composite_pipeline: CompositePipeline,
    downsample_pipeline: DownsamplePipeline,
    textures: Option<ProcessorTextures>,
    mask_data: Vec<f32>,
    smoothed_mask: Vec<f32>,
    mask_scratch: Vec<f32>,
    mask_upload: Vec<f32>,
    last_inference: Instant,
    downsample_texture: wgpu::Texture,
    downsample_view: wgpu::TextureView,
    readback_buffer: wgpu::Buffer,
    readback_bytes_per_row: u32,
    readback_state: ReadbackState,
    inference_interval: Duration,
    inference_requested: bool,
    mask_initialized: bool,
    mask_dirty: bool,
    output_generation: u64,
    output_sequence: u64,
    mask_status: MaskStatusTracker,
    last_output_status: Option<BlurOutputStatus>,
    // Keep last: must drop after every other field (see BlurSessionHandle).
    _blur_session: BlurSessionHandle,
}

struct DownsamplePipeline {
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
}

impl DownsamplePipeline {
    fn new(device: &wgpu::Device) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Downsample Shader"),
            source: wgpu::ShaderSource::Wgsl(BLIT_SHADER.into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Downsample BGL"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Downsample Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Downsample Pipeline"),
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
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Self {
            pipeline,
            bind_group_layout,
            sampler,
        }
    }
}

struct ProcessorTextures {
    width: u32,
    height: u32,
    _blurred_texture: wgpu::Texture,
    blurred_view: wgpu::TextureView,
    _blur_intermediate: wgpu::Texture,
    blur_intermediate_view: wgpu::TextureView,
    mask_texture: wgpu::Texture,
    mask_view: wgpu::TextureView,
    output_texture: wgpu::Texture,
    output_view: wgpu::TextureView,
}

impl BlurProcessor {
    pub fn new(device: &wgpu::Device, output_format: wgpu::TextureFormat) -> anyhow::Result<Self> {
        if blur_disabled() {
            anyhow::bail!("camera background blur disabled by crash recovery");
        }

        // Armed before the ONNX session is created: model load and the first
        // GPU work are both native-crash sites we need attributed to blur.
        notify_blur_session(true);
        Self::new_inner(device, output_format, BlurSessionHandle)
    }

    fn new_inner(
        device: &wgpu::Device,
        output_format: wgpu::TextureFormat,
        blur_session: BlurSessionHandle,
    ) -> anyhow::Result<Self> {
        let model = SegmentationModel::new()?;
        let blur_pipeline = BlurPipeline::new(device);
        let composite_pipeline = CompositePipeline::new(device, output_format);
        let downsample_pipeline = DownsamplePipeline::new(device);
        let pixel_count = (SEGMENTATION_SIZE * SEGMENTATION_SIZE) as usize;

        let downsample_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Downsample 256"),
            size: wgpu::Extent3d {
                width: SEGMENTATION_SIZE,
                height: SEGMENTATION_SIZE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let downsample_view = downsample_texture.create_view(&Default::default());

        let readback_bytes_per_row = (SEGMENTATION_SIZE * 4).div_ceil(256) * 256;
        let readback_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Segmentation Readback"),
            size: (readback_bytes_per_row * SEGMENTATION_SIZE) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        Ok(Self {
            model,
            blur_pipeline,
            composite_pipeline,
            downsample_pipeline,
            textures: None,
            mask_data: vec![INITIAL_MASK_VALUE; pixel_count],
            smoothed_mask: vec![INITIAL_MASK_VALUE; pixel_count],
            mask_scratch: vec![INITIAL_MASK_VALUE; pixel_count],
            mask_upload: vec![INITIAL_MASK_VALUE; pixel_count],
            last_inference: Instant::now()
                .checked_sub(std::time::Duration::from_secs(1))
                .unwrap_or_else(Instant::now),
            downsample_texture,
            downsample_view,
            readback_buffer,
            readback_bytes_per_row,
            readback_state: ReadbackState::Idle,
            inference_interval: DEFAULT_INFERENCE_INTERVAL,
            inference_requested: false,
            mask_initialized: false,
            mask_dirty: true,
            output_generation: 0,
            output_sequence: 0,
            mask_status: MaskStatusTracker::default(),
            last_output_status: None,
            _blur_session: blur_session,
        })
    }

    pub fn set_inference_interval(&mut self, interval: Duration) {
        self.inference_interval = interval;
    }

    /// Call between outputs after submitting prior work; discard queued output readbacks too.
    pub fn reset_mask_history(&mut self) {
        if matches!(self.readback_state, ReadbackState::InFlight { .. }) {
            self.readback_buffer.unmap();
        }
        self.readback_state = ReadbackState::Idle;
        reset_mask_buffers([
            &mut self.mask_data,
            &mut self.smoothed_mask,
            &mut self.mask_scratch,
            &mut self.mask_upload,
        ]);
        self.mask_initialized = false;
        self.mask_dirty = true;
        self.inference_requested = true;
        self.mask_status.reset();
        self.last_output_status = None;
    }

    pub fn output_generation(&self) -> u64 {
        self.output_generation
    }

    /// Describes encoded work; the caller must complete its GPU submission before using the output.
    pub fn output_status(&self) -> Option<BlurOutputStatus> {
        self.last_output_status.clone()
    }

    pub fn output_view(&self) -> Option<&wgpu::TextureView> {
        self.textures.as_ref().map(|t| &t.output_view)
    }

    pub fn process(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        input_texture: &wgpu::Texture,
        mode: BlurMode,
    ) -> &wgpu::Texture {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Background Blur Encoder"),
        });

        self.process_into_encoder(device, queue, input_texture, &mut encoder, mode);

        queue.submit(std::iter::once(encoder.finish()));

        &self
            .textures
            .as_ref()
            .expect("textures initialized above")
            .output_texture
    }

    pub fn process_into_encoder(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        input_texture: &wgpu::Texture,
        encoder: &mut wgpu::CommandEncoder,
        mode: BlurMode,
    ) {
        let width = input_texture.width();
        let height = input_texture.height();

        self.ensure_textures(device, width, height);
        let input_view = input_texture.create_view(&Default::default());

        if self.inference_requested || self.last_inference.elapsed() >= self.inference_interval {
            self.inference_requested = false;
            let mask_updated = self.run_segmentation(device, queue, input_texture);
            self.last_inference = Instant::now();
            if mask_updated {
                self.mask_dirty = true;
            }
        }

        if self.mask_dirty {
            self.upload_mask(queue);
            self.mask_dirty = false;
        }

        let textures = self.textures.as_ref().expect("textures initialized above");

        let (blur_intensity, blur_passes) = match mode {
            BlurMode::Light => (1.5, 1),
            BlurMode::Heavy => (2.0, 3),
        };

        for pass_index in 0..blur_passes {
            let source = if pass_index == 0 {
                &input_view
            } else {
                &textures.blurred_view
            };

            self.blur_pipeline.blur_two_pass(
                device,
                encoder,
                BlurPassInputs {
                    source,
                    intermediate: &textures.blur_intermediate_view,
                    output: &textures.blurred_view,
                    width,
                    height,
                    intensity: blur_intensity,
                },
            );
        }

        self.composite_pipeline.composite(
            device,
            encoder,
            &input_view,
            &textures.blurred_view,
            &textures.mask_view,
            &textures.output_view,
        );
        self.output_sequence = self.output_sequence.wrapping_add(1);
        self.last_output_status = Some(BlurOutputStatus {
            mode,
            output_sequence: self.output_sequence,
            output_dimensions: (width, height),
            mask: self.mask_status.status.clone(),
        });
    }

    pub fn process_returning_output(&mut self) -> Option<&wgpu::Texture> {
        self.textures.as_ref().map(|t| &t.output_texture)
    }

    fn ensure_textures(&mut self, device: &wgpu::Device, width: u32, height: u32) {
        if let Some(t) = &self.textures
            && t.width == width
            && t.height == height
        {
            return;
        }

        let create_rgba_texture = |label: &str, w: u32, h: u32, usage: wgpu::TextureUsages| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage,
                view_formats: &[],
            })
        };

        let tex_usage = wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC;

        let blurred = create_rgba_texture("Blurred Camera", width, height, tex_usage);
        let blur_inter = create_rgba_texture("Blur Intermediate", width, height, tex_usage);
        let output_texture = create_rgba_texture("Blur Output", width, height, tex_usage);

        let mask_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Segmentation Mask"),
            size: wgpu::Extent3d {
                width: SEGMENTATION_SIZE,
                height: SEGMENTATION_SIZE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        self.textures = Some(ProcessorTextures {
            width,
            height,
            blurred_view: blurred.create_view(&Default::default()),
            _blurred_texture: blurred,
            blur_intermediate_view: blur_inter.create_view(&Default::default()),
            _blur_intermediate: blur_inter,
            mask_view: mask_texture.create_view(&Default::default()),
            mask_texture,
            output_view: output_texture.create_view(&Default::default()),
            output_texture,
        });
        self.output_generation = self.output_generation.wrapping_add(1);
        self.mask_dirty = true;
    }

    fn run_segmentation(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        input_texture: &wgpu::Texture,
    ) -> bool {
        let failure_revision = self.mask_status.failure_revision;
        let rgba_256 =
            match self.readback_downsampled(device, queue, input_texture, !self.mask_initialized) {
                Some(data) => data,
                None => return false,
            };

        match self.model.run_inference(&rgba_256.pixels) {
            Ok(new_mask) => {
                let pixel_count = (SEGMENTATION_SIZE * SEGMENTATION_SIZE) as usize;
                let mask_validation = validate_mask_samples(new_mask, pixel_count);
                if let Err(error) = &mask_validation {
                    self.mask_status.fail(error.clone());
                }
                if new_mask.len() >= pixel_count {
                    for (i, &raw) in new_mask.iter().take(pixel_count).enumerate() {
                        let v = refine_mask_value(raw);
                        self.smoothed_mask[i] = if self.mask_initialized {
                            smooth_mask_value(self.smoothed_mask[i], v)
                        } else {
                            v
                        };
                    }
                    self.mask_data
                        .copy_from_slice(&self.smoothed_mask[..pixel_count]);
                    self.mask_initialized = true;
                    let smoothed_validation = validate_mask_samples(&self.mask_data, pixel_count);
                    if let Err(error) = &smoothed_validation {
                        self.mask_status.fail(error.clone());
                    }
                    if mask_validation.is_ok() && smoothed_validation.is_ok() {
                        self.mask_status.complete(
                            failure_revision,
                            rgba_256.submitted_at,
                            rgba_256.dimensions,
                            Instant::now(),
                        );
                    }
                    return true;
                }
                false
            }
            Err(e) => {
                tracing::warn!("Segmentation inference failed: {e:#}");
                self.mask_status
                    .fail(BlurFailure::Inference(format!("{e:#}")));
                false
            }
        }
    }

    fn readback_downsampled(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        input_texture: &wgpu::Texture,
        wait_for_result: bool,
    ) -> Option<ReadbackFrame> {
        let mut completed = self.take_completed_readback(device, wgpu::PollType::Poll);

        if matches!(self.readback_state, ReadbackState::Idle) {
            let input_view = input_texture.create_view(&Default::default());

            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Downsample BG"),
                layout: &self.downsample_pipeline.bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&input_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.downsample_pipeline.sampler),
                    },
                ],
            });

            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Downsample Encoder"),
            });

            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Downsample Pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &self.downsample_view,
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
                pass.set_pipeline(&self.downsample_pipeline.pipeline);
                pass.set_bind_group(0, &bind_group, &[]);
                pass.draw(0..3, 0..1);
            }

            let bytes_per_row = self.readback_bytes_per_row;
            encoder.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.downsample_texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyBufferInfo {
                    buffer: &self.readback_buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(bytes_per_row),
                        rows_per_image: Some(SEGMENTATION_SIZE),
                    },
                },
                wgpu::Extent3d {
                    width: SEGMENTATION_SIZE,
                    height: SEGMENTATION_SIZE,
                    depth_or_array_layers: 1,
                },
            );

            let submitted_at = Instant::now();
            queue.submit(std::iter::once(encoder.finish()));

            let status = Arc::new(AtomicU8::new(READBACK_PENDING));
            let status_cb = status.clone();
            self.readback_buffer
                .slice(..)
                .map_async(wgpu::MapMode::Read, move |result| {
                    let code = if result.is_ok() {
                        READBACK_READY_OK
                    } else {
                        READBACK_READY_ERR
                    };
                    status_cb.store(code, Ordering::Release);
                });

            self.readback_state = ReadbackState::InFlight {
                status,
                submitted_at,
                dimensions: (input_texture.width(), input_texture.height()),
            };

            if wait_for_result {
                completed = self
                    .take_completed_readback(device, wgpu::PollType::Wait)
                    .or(completed);
            }
        }

        completed
    }

    fn take_completed_readback(
        &mut self,
        device: &wgpu::Device,
        poll_type: wgpu::PollType,
    ) -> Option<ReadbackFrame> {
        if let ReadbackState::InFlight {
            status,
            submitted_at,
            dimensions,
        } = &self.readback_state
        {
            let submitted_at = *submitted_at;
            let dimensions = *dimensions;
            if let Err(error) = device.poll(poll_type) {
                self.mask_status.fail(BlurFailure::Readback(format!(
                    "GPU polling failed: {error}"
                )));
            }
            match status.load(Ordering::Acquire) {
                READBACK_READY_OK => {
                    let slice = self.readback_buffer.slice(..);
                    let data = slice.get_mapped_range();
                    let expected_row = (SEGMENTATION_SIZE * 4) as usize;
                    let bytes_per_row = self.readback_bytes_per_row as usize;
                    let mut out = Vec::with_capacity(expected_row * SEGMENTATION_SIZE as usize);
                    for row in 0..SEGMENTATION_SIZE as usize {
                        let start = row * bytes_per_row;
                        out.extend_from_slice(&data[start..start + expected_row]);
                    }
                    drop(data);
                    self.readback_buffer.unmap();
                    self.readback_state = ReadbackState::Idle;
                    Some(ReadbackFrame {
                        pixels: out,
                        submitted_at,
                        dimensions,
                    })
                }
                READBACK_READY_ERR => {
                    self.readback_state = ReadbackState::Idle;
                    self.mask_status.fail(BlurFailure::Readback(
                        "GPU mask readback failed".to_string(),
                    ));
                    None
                }
                _ => None,
            }
        } else {
            None
        }
    }

    fn upload_mask(&mut self, queue: &wgpu::Queue) {
        let Some(textures) = &self.textures else {
            return;
        };

        let w = SEGMENTATION_SIZE as usize;

        blur_mask_1d(&self.mask_data, &mut self.mask_scratch, w, true);
        blur_mask_1d(&self.mask_scratch, &mut self.mask_upload, w, false);
        blur_mask_1d(&self.mask_upload, &mut self.mask_scratch, w, true);
        blur_mask_1d(&self.mask_scratch, &mut self.mask_upload, w, false);

        let mask_u8: Vec<u8> = self
            .mask_upload
            .iter()
            .map(|&v| (v.clamp(0.0, 1.0) * 255.0) as u8)
            .collect();

        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &textures.mask_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &mask_u8,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(SEGMENTATION_SIZE),
                rows_per_image: Some(SEGMENTATION_SIZE),
            },
            wgpu::Extent3d {
                width: SEGMENTATION_SIZE,
                height: SEGMENTATION_SIZE,
                depth_or_array_layers: 1,
            },
        );
    }
}

fn blur_mask_1d(src: &[f32], dst: &mut [f32], width: usize, horizontal: bool) {
    let kernel = [0.06136, 0.24477, 0.38774, 0.24477, 0.06136];
    let height = src.len() / width;

    for y in 0..height {
        for x in 0..width {
            let mut sum = 0.0;
            for (ki, &weight) in kernel.iter().enumerate() {
                let offset = ki as isize - 2;
                let (sx, sy) = if horizontal {
                    (
                        (x as isize + offset).clamp(0, width as isize - 1) as usize,
                        y,
                    )
                } else {
                    (
                        x,
                        (y as isize + offset).clamp(0, height as isize - 1) as usize,
                    )
                };
                sum += src[sy * width + sx] * weight;
            }
            dst[y * width + x] = sum;
        }
    }
}

fn refine_mask_value(raw: f32) -> f32 {
    let clamped = raw.clamp(0.0, 1.0);
    let shifted = (clamped - 0.5) * MASK_EDGE_CONTRAST;
    1.0 / (1.0 + (-shifted).exp())
}

fn smooth_mask_value(previous: f32, next: f32) -> f32 {
    let delta = next - previous;
    if delta.abs() < MASK_STABILITY_EPSILON {
        previous
    } else {
        let alpha = if delta > 0.0 {
            MASK_GROWTH_ALPHA
        } else {
            MASK_SHRINK_ALPHA
        };
        (previous + delta * alpha).clamp(0.0, 1.0)
    }
}

const BLIT_SHADER: &str = r"
@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    var uvs = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0),
    );
    var out: VertexOutput;
    out.position = vec4<f32>(positions[vi], 0.0, 1.0);
    out.uv = uvs[vi];
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(src_tex, src_sampler, in.uv);
}
";

#[cfg(test)]
mod blur_status_tests {
    use super::*;

    #[test]
    fn reset_invalidates_ready_and_failed_masks_until_new_inference() {
        let now = Instant::now();
        let mut tracker = MaskStatusTracker::default();
        tracker.complete(0, now, (640, 480), now);
        let previous_generation = tracker.generation;
        tracker.reset();
        assert_eq!(tracker.status, BlurMaskStatus::Pending);
        assert!(tracker.generation > previous_generation);
        tracker.complete(0, now, (640, 480), now);
        assert_eq!(tracker.status, BlurMaskStatus::Pending);
        tracker.complete(tracker.failure_revision, now, (640, 480), now);
        assert!(matches!(tracker.status, BlurMaskStatus::Ready(_)));
        tracker.fail(BlurFailure::NonFiniteMask);
        tracker.reset();
        assert_eq!(tracker.status, BlurMaskStatus::Pending);
    }

    #[test]
    fn reset_erases_smoothing_without_reallocating_cpu_buffers() {
        let mut data = vec![0.0, 0.5, f32::NAN];
        let mut smoothed = vec![0.2, 0.8];
        let mut scratch = vec![f32::INFINITY, 0.4];
        let mut upload = vec![0.1];
        let pointers = [
            data.as_ptr(),
            smoothed.as_ptr(),
            scratch.as_ptr(),
            upload.as_ptr(),
        ];
        reset_mask_buffers([&mut data, &mut smoothed, &mut scratch, &mut upload]);
        for (index, buffer) in [&data, &smoothed, &scratch, &upload]
            .into_iter()
            .enumerate()
        {
            assert_eq!(buffer.as_ptr(), pointers[index]);
            assert!(buffer.iter().all(|value| *value == INITIAL_MASK_VALUE));
        }
    }

    const DIMS: (u32, u32) = (640, 360);
    const MAX_AGE: Duration = Duration::from_millis(300);

    fn output(tracker: &MaskStatusTracker, mode: BlurMode, sequence: u64) -> BlurOutputStatus {
        BlurOutputStatus {
            mode,
            output_sequence: sequence,
            output_dimensions: DIMS,
            mask: tracker.status.clone(),
        }
    }

    #[test]
    fn initial_default_mask_is_pending_not_applied() {
        let tracker = MaskStatusTracker::default();
        assert_eq!(INITIAL_MASK_VALUE, 1.0);
        assert_eq!(
            output(&tracker, BlurMode::Heavy, 1).applied_at(Instant::now(), MAX_AGE),
            Err(BlurOutputUnavailable::Pending)
        );
    }

    #[test]
    fn successful_mask_binds_exact_output_mode_sequence_and_generation() {
        let start = Instant::now();
        let completed = start + Duration::from_millis(20);
        let mut tracker = MaskStatusTracker::default();
        tracker.complete(0, start, DIMS, completed);
        for (mode, sequence) in [(BlurMode::Light, 3), (BlurMode::Heavy, 4)] {
            let applied = output(&tracker, mode, sequence)
                .applied_at(completed, MAX_AGE)
                .unwrap();
            assert_eq!(applied.mode, mode);
            assert_eq!(applied.output_sequence, sequence);
            assert_eq!(applied.output_dimensions, DIMS);
            assert_eq!(applied.mask.generation, 1);
            assert_eq!(applied.mask.input_submitted_at, start);
            assert_eq!(applied.mask.inference_completed_at, completed);
        }
        tracker.complete(0, completed, DIMS, completed);
        assert_eq!(
            output(&tracker, BlurMode::Light, 5)
                .applied_at(completed, MAX_AGE)
                .unwrap()
                .mask
                .generation,
            2
        );
    }

    #[test]
    fn reused_mask_expires_from_input_submission_not_inference_completion() {
        let start = Instant::now();
        let completed = start + Duration::from_millis(290);
        let mut tracker = MaskStatusTracker::default();
        tracker.complete(0, start, DIMS, completed);
        let status = output(&tracker, BlurMode::Light, 2);
        let boundary = status.applied_at(start + MAX_AGE, MAX_AGE).unwrap();
        assert_eq!(boundary.mask_age, MAX_AGE);
        assert_eq!(boundary.mask.generation, 1);
        let expired_age = MAX_AGE + Duration::from_millis(1);
        assert_eq!(
            status.applied_at(start + expired_age, MAX_AGE),
            Err(BlurOutputUnavailable::Stale {
                mask_age: expired_age,
                max_mask_age: MAX_AGE,
            })
        );
    }

    #[test]
    fn inference_and_readback_failures_invalidate_previous_valid_mask() {
        let now = Instant::now();
        for failure in [
            BlurFailure::Inference("inference failed".into()),
            BlurFailure::Readback("readback failed".into()),
            BlurFailure::InvalidMask {
                expected_samples: 4,
                actual_samples: 2,
            },
            BlurFailure::NonFiniteMask,
        ] {
            let mut tracker = MaskStatusTracker::default();
            tracker.complete(0, now, DIMS, now);
            tracker.fail(failure.clone());
            assert_eq!(
                output(&tracker, BlurMode::Heavy, 2).applied_at(now, MAX_AGE),
                Err(BlurOutputUnavailable::Failed(failure))
            );
        }
    }

    #[test]
    fn completed_old_readback_cannot_hide_new_readback_failure() {
        let now = Instant::now();
        let mut tracker = MaskStatusTracker::default();
        let revision = tracker.failure_revision;
        let failure = BlurFailure::Readback("poll failed".into());
        tracker.fail(failure.clone());
        tracker.complete(revision, now, DIMS, now);
        assert_eq!(tracker.status, BlurMaskStatus::Failed(failure));
        assert_eq!(tracker.generation, 0);
        tracker.complete(tracker.failure_revision, now, DIMS, now);
        assert!(
            output(&tracker, BlurMode::Heavy, 3)
                .applied_at(now, MAX_AGE)
                .is_ok()
        );
        assert_eq!(tracker.generation, 1);
    }

    #[test]
    fn resized_output_cannot_claim_old_geometry_mask() {
        let now = Instant::now();
        let mut tracker = MaskStatusTracker::default();
        tracker.complete(0, now, DIMS, now);
        let mut status = output(&tracker, BlurMode::Heavy, 1);
        status.output_dimensions = (320, 180);
        assert_eq!(
            status.applied_at(now, MAX_AGE),
            Err(BlurOutputUnavailable::MaskGeometryMismatch)
        );
    }

    #[test]
    fn future_or_inverted_mask_timestamps_are_rejected() {
        let now = Instant::now();
        let later = now + Duration::from_millis(1);
        for (submitted, completed) in [(later, now), (now, later)] {
            let mut tracker = MaskStatusTracker::default();
            tracker.complete(0, submitted, DIMS, completed);
            assert_eq!(
                output(&tracker, BlurMode::Light, 1).applied_at(now, MAX_AGE),
                Err(BlurOutputUnavailable::InvalidTimestamp)
            );
        }
    }

    #[test]
    fn invalid_masks_fail_but_real_uniform_segmentation_is_valid() {
        assert_eq!(
            validate_mask_samples(&[1.0], 2),
            Err(BlurFailure::InvalidMask {
                expected_samples: 2,
                actual_samples: 1,
            })
        );
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(
                validate_mask_samples(&[0.5, value], 2),
                Err(BlurFailure::NonFiniteMask)
            );
        }
        for mask in [[0.0; 2], [1.0; 2]] {
            assert_eq!(validate_mask_samples(&mask, 2), Ok(()));
        }
        assert_eq!(validate_mask_samples(&[0.0, 1.0, f32::NAN], 2), Ok(()));
    }

    #[test]
    fn valid_new_inference_cannot_certify_nan_contaminated_smoothed_mask() {
        let next = refine_mask_value(0.5);
        assert_eq!(validate_mask_samples(&[next], 1), Ok(()));
        let smoothed = smooth_mask_value(f32::NAN, next);
        assert_eq!(
            validate_mask_samples(&[smoothed], 1),
            Err(BlurFailure::NonFiniteMask)
        );
    }
}
