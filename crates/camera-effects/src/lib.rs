mod blur_pipeline;
mod segmentation;

use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Instant;

use blur_pipeline::{BlurPassInputs, BlurPipeline, CompositePipeline};
use segmentation::SegmentationModel;

const READBACK_PENDING: u8 = 0;
const READBACK_READY_OK: u8 = 1;
const READBACK_READY_ERR: u8 = 2;

enum ReadbackState {
    Idle,
    InFlight(Arc<AtomicU8>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlurMode {
    Light,
    Heavy,
}

const SEGMENTATION_SIZE: u32 = 256;
const INFERENCE_INTERVAL_MS: u64 = 66;
const EMA_ALPHA: f32 = 0.7;

pub struct BlurProcessor {
    model: SegmentationModel,
    blur_pipeline: BlurPipeline,
    composite_pipeline: CompositePipeline,
    downsample_pipeline: DownsamplePipeline,
    textures: Option<ProcessorTextures>,
    mask_data: Vec<f32>,
    smoothed_mask: Vec<f32>,
    mask_scratch: Vec<f32>,
    last_inference: Instant,
    downsample_texture: wgpu::Texture,
    downsample_view: wgpu::TextureView,
    readback_buffer: wgpu::Buffer,
    readback_bytes_per_row: u32,
    readback_state: ReadbackState,
    mask_dirty: bool,
    output_generation: u64,
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
            mask_data: vec![0.0; pixel_count],
            smoothed_mask: vec![0.0; pixel_count],
            mask_scratch: vec![0.0; pixel_count],
            last_inference: Instant::now()
                .checked_sub(std::time::Duration::from_secs(1))
                .unwrap_or_else(Instant::now),
            downsample_texture,
            downsample_view,
            readback_buffer,
            readback_bytes_per_row,
            readback_state: ReadbackState::Idle,
            mask_dirty: true,
            output_generation: 0,
        })
    }

    pub fn output_generation(&self) -> u64 {
        self.output_generation
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

        if self.last_inference.elapsed().as_millis() >= INFERENCE_INTERVAL_MS as u128 {
            self.run_segmentation(device, queue, input_texture);
            self.last_inference = Instant::now();
            self.mask_dirty = true;
        }

        if self.mask_dirty {
            self.upload_mask(queue);
            self.mask_dirty = false;
        }

        let textures = self.textures.as_ref().expect("textures initialized above");

        let blur_intensity = match mode {
            BlurMode::Light => 0.75,
            BlurMode::Heavy => 2.0,
        };

        self.blur_pipeline.blur_two_pass(
            device,
            encoder,
            BlurPassInputs {
                source: &input_view,
                intermediate: &textures.blur_intermediate_view,
                output: &textures.blurred_view,
                width,
                height,
                intensity: blur_intensity,
            },
        );

        self.composite_pipeline.composite(
            device,
            encoder,
            &input_view,
            &textures.blurred_view,
            &textures.mask_view,
            &textures.output_view,
        );
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
    ) {
        let rgba_256 = match self.readback_downsampled(device, queue, input_texture) {
            Some(data) => data,
            None => return,
        };

        match self.model.run_inference(&rgba_256) {
            Ok(new_mask) => {
                let pixel_count = (SEGMENTATION_SIZE * SEGMENTATION_SIZE) as usize;
                if new_mask.len() >= pixel_count {
                    for (i, &raw) in new_mask.iter().take(pixel_count).enumerate() {
                        let v = refine_mask_value(raw);
                        self.smoothed_mask[i] =
                            EMA_ALPHA * v + (1.0 - EMA_ALPHA) * self.smoothed_mask[i];
                    }
                    self.mask_data
                        .copy_from_slice(&self.smoothed_mask[..pixel_count]);
                }
            }
            Err(e) => {
                tracing::warn!("Segmentation inference failed: {e:#}");
            }
        }
    }

    fn readback_downsampled(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        input_texture: &wgpu::Texture,
    ) -> Option<Vec<u8>> {
        let mut completed: Option<Vec<u8>> = None;

        if let ReadbackState::InFlight(status) = &self.readback_state {
            let _ = device.poll(wgpu::PollType::Poll);
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
                    completed = Some(out);
                }
                READBACK_READY_ERR => {
                    self.readback_state = ReadbackState::Idle;
                }
                _ => {}
            }
        }

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

            self.readback_state = ReadbackState::InFlight(status);
        }

        completed
    }

    fn upload_mask(&mut self, queue: &wgpu::Queue) {
        let Some(textures) = &self.textures else {
            return;
        };

        let w = SEGMENTATION_SIZE as usize;

        blur_mask_1d(&self.mask_data, &mut self.mask_scratch, w, true);
        blur_mask_1d(&self.mask_scratch, &mut self.mask_data, w, false);
        blur_mask_1d(&self.mask_data, &mut self.mask_scratch, w, true);
        blur_mask_1d(&self.mask_scratch, &mut self.mask_data, w, false);

        let mask_u8: Vec<u8> = self
            .mask_data
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
    let shifted = (clamped - 0.5) * 6.0;
    1.0 / (1.0 + (-shifted).exp())
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
