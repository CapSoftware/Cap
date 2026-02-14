use std::sync::Arc;
use std::time::Instant;
use tokio::sync::oneshot;
use wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;

use crate::{ProjectUniforms, RenderingError};

const GPU_BUFFER_WAIT_TIMEOUT_SECS: u64 = 10;

pub struct RgbaToNv12Converter {
    pipeline: wgpu::ComputePipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    params_buffer: wgpu::Buffer,
    nv12_buffer: Option<wgpu::Buffer>,
    readback_buffer: Option<Arc<wgpu::Buffer>>,
    cached_width: u32,
    cached_height: u32,
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct Nv12Params {
    width: u32,
    height: u32,
    y_stride: u32,
    uv_stride: u32,
}

impl RgbaToNv12Converter {
    pub fn new(device: &wgpu::Device) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("RGBA to NV12 Converter"),
            source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Borrowed(include_str!(
                "shaders/rgba_to_nv12.wgsl"
            ))),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("RGBA to NV12 Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("RGBA to NV12 Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("RGBA to NV12 Pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });

        let params_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("NV12 Params Buffer"),
            size: std::mem::size_of::<Nv12Params>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Self {
            pipeline,
            bind_group_layout,
            params_buffer,
            nv12_buffer: None,
            readback_buffer: None,
            cached_width: 0,
            cached_height: 0,
        }
    }

    fn nv12_size(width: u32, height: u32) -> u64 {
        let y_size = (width as u64) * (height as u64);
        let uv_size = (width as u64) * (height as u64 / 2);
        y_size + uv_size
    }

    fn ensure_buffers(&mut self, device: &wgpu::Device, width: u32, height: u32) {
        if self.cached_width == width && self.cached_height == height {
            return;
        }

        let nv12_size = Self::nv12_size(width, height);
        let aligned_size = ((nv12_size + 3) / 4) * 4;

        self.nv12_buffer = Some(device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("NV12 Storage Buffer"),
            size: aligned_size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        }));

        self.readback_buffer = Some(Arc::new(device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("NV12 Readback Buffer"),
            size: nv12_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        })));

        self.cached_width = width;
        self.cached_height = height;
    }

    pub fn convert_and_readback(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        source_texture: &wgpu::Texture,
        width: u32,
        height: u32,
        frame_number: u32,
        frame_rate: u32,
    ) -> Option<PendingNv12Readback> {
        if width == 0 || height == 0 || width % 4 != 0 || height % 2 != 0 {
            return None;
        }

        self.ensure_buffers(device, width, height);

        let nv12_buffer = self.nv12_buffer.as_ref()?;
        let readback_buffer = self.readback_buffer.as_ref()?.clone();

        let y_stride = width;
        let uv_stride = width;

        let params = Nv12Params {
            width,
            height,
            y_stride,
            uv_stride,
        };
        queue.write_buffer(&self.params_buffer, 0, bytemuck::cast_slice(&[params]));

        let source_view = source_texture.create_view(&Default::default());

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("RGBA to NV12 Bind Group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&source_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: nv12_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: self.params_buffer.as_entire_binding(),
                },
            ],
        });

        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("RGBA to NV12 Conversion"),
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups(width.div_ceil(4 * 8), height.div_ceil(2 * 8), 1);
        }

        let nv12_size = Self::nv12_size(width, height);
        encoder.copy_buffer_to_buffer(nv12_buffer, 0, &readback_buffer, 0, nv12_size);

        let (tx, rx) = oneshot::channel();
        readback_buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = tx.send(result);
            });

        Some(PendingNv12Readback {
            rx,
            buffer: readback_buffer,
            width,
            height,
            y_stride,
            frame_number,
            frame_rate,
        })
    }
}

pub struct PendingNv12Readback {
    rx: oneshot::Receiver<Result<(), wgpu::BufferAsyncError>>,
    buffer: Arc<wgpu::Buffer>,
    pub width: u32,
    pub height: u32,
    pub y_stride: u32,
    pub frame_number: u32,
    pub frame_rate: u32,
}

impl PendingNv12Readback {
    pub async fn wait(
        mut self,
        device: &wgpu::Device,
    ) -> Result<Nv12RenderedFrame, RenderingError> {
        let mut poll_count = 0u32;
        let start_time = Instant::now();
        let timeout_duration = std::time::Duration::from_secs(GPU_BUFFER_WAIT_TIMEOUT_SECS);

        loop {
            if start_time.elapsed() > timeout_duration {
                return Err(RenderingError::BufferMapWaitingFailed);
            }

            match self.rx.try_recv() {
                Ok(result) => {
                    result?;
                    break;
                }
                Err(oneshot::error::TryRecvError::Empty) => {
                    device.poll(wgpu::PollType::Poll)?;
                    poll_count += 1;
                    if poll_count < 10 {
                        tokio::task::yield_now().await;
                    } else if poll_count < 100 {
                        tokio::time::sleep(std::time::Duration::from_micros(100)).await;
                    } else {
                        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                    }
                }
                Err(oneshot::error::TryRecvError::Closed) => {
                    return Err(RenderingError::BufferMapWaitingFailed);
                }
            }
        }

        let buffer_slice = self.buffer.slice(..);
        let data = buffer_slice.get_mapped_range();
        let nv12_data = data.to_vec();

        drop(data);
        self.buffer.unmap();

        let target_time_ns =
            (self.frame_number as u64 * 1_000_000_000) / self.frame_rate.max(1) as u64;

        Ok(Nv12RenderedFrame {
            data: nv12_data,
            width: self.width,
            height: self.height,
            y_stride: self.y_stride,
            frame_number: self.frame_number,
            target_time_ns,
        })
    }
}

pub struct Nv12RenderedFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub y_stride: u32,
    pub frame_number: u32,
    pub target_time_ns: u64,
}

pub struct PendingReadback {
    rx: oneshot::Receiver<Result<(), wgpu::BufferAsyncError>>,
    buffer: Arc<wgpu::Buffer>,
    padded_bytes_per_row: u32,
    width: u32,
    height: u32,
    frame_number: u32,
    frame_rate: u32,
}

impl PendingReadback {
    pub async fn wait(mut self, device: &wgpu::Device) -> Result<RenderedFrame, RenderingError> {
        let mut poll_count = 0u32;
        let start_time = Instant::now();
        let timeout_duration = std::time::Duration::from_secs(GPU_BUFFER_WAIT_TIMEOUT_SECS);

        loop {
            if start_time.elapsed() > timeout_duration {
                tracing::error!(
                    frame_number = self.frame_number,
                    elapsed_secs = start_time.elapsed().as_secs(),
                    poll_count = poll_count,
                    "GPU buffer mapping timed out after {}s",
                    GPU_BUFFER_WAIT_TIMEOUT_SECS
                );
                return Err(RenderingError::BufferMapWaitingFailed);
            }

            match self.rx.try_recv() {
                Ok(result) => {
                    result?;
                    break;
                }
                Err(oneshot::error::TryRecvError::Empty) => {
                    device.poll(wgpu::PollType::Poll)?;
                    poll_count += 1;
                    if poll_count < 10 {
                        tokio::task::yield_now().await;
                    } else if poll_count < 100 {
                        tokio::time::sleep(std::time::Duration::from_micros(100)).await;
                    } else {
                        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                    }
                    if poll_count.is_multiple_of(10000) {
                        tracing::warn!(
                            frame_number = self.frame_number,
                            poll_count = poll_count,
                            elapsed_ms = start_time.elapsed().as_millis() as u64,
                            "GPU buffer mapping taking longer than expected"
                        );
                    }
                }
                Err(oneshot::error::TryRecvError::Closed) => {
                    return Err(RenderingError::BufferMapWaitingFailed);
                }
            }
        }

        let buffer_slice = self.buffer.slice(..);
        let data = buffer_slice.get_mapped_range();
        let mut data_vec = Vec::with_capacity(data.len() + 24);
        data_vec.extend_from_slice(&data);

        drop(data);
        self.buffer.unmap();

        let target_time_ns =
            (self.frame_number as u64 * 1_000_000_000) / self.frame_rate.max(1) as u64;

        Ok(RenderedFrame {
            data: data_vec,
            padded_bytes_per_row: self.padded_bytes_per_row,
            width: self.width,
            height: self.height,
            frame_number: self.frame_number,
            target_time_ns,
        })
    }
}

pub struct PipelinedGpuReadback {
    buffers: [Arc<wgpu::Buffer>; 3],
    buffer_size: u64,
    current_index: usize,
    pending: Option<PendingReadback>,
    needs_resize: bool,
    pending_resize_size: u64,
}

impl PipelinedGpuReadback {
    pub fn new(device: &wgpu::Device, initial_size: u64) -> Self {
        let make_buffer = || {
            Arc::new(device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Pipelined Readback Buffer"),
                size: initial_size,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            }))
        };

        Self {
            buffers: [make_buffer(), make_buffer(), make_buffer()],
            buffer_size: initial_size,
            current_index: 0,
            pending: None,
            needs_resize: false,
            pending_resize_size: 0,
        }
    }

    pub fn mark_for_resize(&mut self, required_size: u64) {
        if self.buffer_size < required_size {
            self.needs_resize = true;
            self.pending_resize_size = required_size;
        }
    }

    pub fn perform_resize_if_needed(&mut self, device: &wgpu::Device) {
        if self.needs_resize && self.pending.is_none() {
            let required_size = self.pending_resize_size;
            tracing::info!(
                old_size = self.buffer_size,
                new_size = required_size,
                "Resizing GPU readback buffers"
            );
            let make_buffer = || {
                Arc::new(device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("Pipelined Readback Buffer"),
                    size: required_size,
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                }))
            };

            self.buffers = [make_buffer(), make_buffer(), make_buffer()];
            self.buffer_size = required_size;
            self.current_index = 0;
            self.needs_resize = false;
            self.pending_resize_size = 0;
        }
    }

    pub fn ensure_size(&mut self, device: &wgpu::Device, required_size: u64) {
        if self.buffer_size < required_size {
            if self.pending.is_some() {
                self.mark_for_resize(required_size);
            } else {
                let make_buffer = || {
                    Arc::new(device.create_buffer(&wgpu::BufferDescriptor {
                        label: Some("Pipelined Readback Buffer"),
                        size: required_size,
                        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                        mapped_at_creation: false,
                    }))
                };

                self.buffers = [make_buffer(), make_buffer(), make_buffer()];
                self.buffer_size = required_size;
                self.current_index = 0;
            }
        }
    }

    fn next_buffer(&mut self) -> Arc<wgpu::Buffer> {
        let buffer = self.buffers[self.current_index].clone();
        self.current_index = (self.current_index + 1) % self.buffers.len();
        buffer
    }

    pub fn submit_readback(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        texture: &wgpu::Texture,
        uniforms: &ProjectUniforms,
        mut render_encoder: wgpu::CommandEncoder,
    ) -> Result<(), RenderingError> {
        let padded_bytes_per_row = padded_bytes_per_row(uniforms.output_size);
        let output_buffer_size = (padded_bytes_per_row * uniforms.output_size.1) as u64;

        self.ensure_size(device, output_buffer_size);
        let buffer = self.next_buffer();

        let output_texture_size = wgpu::Extent3d {
            width: uniforms.output_size.0,
            height: uniforms.output_size.1,
            depth_or_array_layers: 1,
        };

        render_encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row),
                    rows_per_image: Some(uniforms.output_size.1),
                },
            },
            output_texture_size,
        );

        queue.submit(std::iter::once(render_encoder.finish()));

        let (tx, rx) = oneshot::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                if let Err(e) = tx.send(result) {
                    tracing::error!("Failed to send map_async result: {:?}", e);
                }
            });

        self.pending = Some(PendingReadback {
            rx,
            buffer,
            padded_bytes_per_row,
            width: uniforms.output_size.0,
            height: uniforms.output_size.1,
            frame_number: uniforms.frame_number,
            frame_rate: uniforms.frame_rate,
        });

        Ok(())
    }

    pub fn take_pending(&mut self) -> Option<PendingReadback> {
        self.pending.take()
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }
}

pub struct RenderSession {
    pub textures: (wgpu::Texture, wgpu::Texture),
    texture_views: (wgpu::TextureView, wgpu::TextureView),
    pub current_is_left: bool,
    pub pipelined_readback: PipelinedGpuReadback,
    texture_width: u32,
    texture_height: u32,
}

impl RenderSession {
    pub fn new(device: &wgpu::Device, width: u32, height: u32) -> Self {
        let make_texture = || {
            device.create_texture(&wgpu::TextureDescriptor {
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
                    | wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::COPY_SRC,
                label: Some("Intermediate Texture"),
                view_formats: &[],
            })
        };

        let textures = (make_texture(), make_texture());
        let padded = padded_bytes_per_row((width, height));
        let initial_buffer_size = (padded * height) as u64;

        Self {
            current_is_left: true,
            texture_views: (
                textures.0.create_view(&Default::default()),
                textures.1.create_view(&Default::default()),
            ),
            textures,
            pipelined_readback: PipelinedGpuReadback::new(device, initial_buffer_size),
            texture_width: width,
            texture_height: height,
        }
    }

    pub fn update_texture_size(&mut self, device: &wgpu::Device, width: u32, height: u32) {
        if self.texture_width == width && self.texture_height == height {
            return;
        }

        tracing::info!(
            old_width = self.texture_width,
            old_height = self.texture_height,
            new_width = width,
            new_height = height,
            "Resizing render session textures"
        );

        let make_texture = || {
            device.create_texture(&wgpu::TextureDescriptor {
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
                    | wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::COPY_SRC,
                label: Some("Intermediate Texture"),
                view_formats: &[],
            })
        };

        self.textures = (make_texture(), make_texture());
        self.texture_views = (
            self.textures.0.create_view(&Default::default()),
            self.textures.1.create_view(&Default::default()),
        );
        self.texture_width = width;
        self.texture_height = height;
    }

    pub fn current_texture(&self) -> &wgpu::Texture {
        if self.current_is_left {
            &self.textures.0
        } else {
            &self.textures.1
        }
    }

    pub fn current_texture_view(&self) -> &wgpu::TextureView {
        if self.current_is_left {
            &self.texture_views.0
        } else {
            &self.texture_views.1
        }
    }

    pub fn other_texture_view(&self) -> &wgpu::TextureView {
        if self.current_is_left {
            &self.texture_views.1
        } else {
            &self.texture_views.0
        }
    }

    pub fn swap_textures(&mut self) {
        self.current_is_left = !self.current_is_left;
    }
}

// pub struct FramePipelineState<'a> {
//     pub constants: &'a RenderVideoConstants,
//     pub uniforms: &'a ProjectUniforms,
//     pub texture: &'a wgpu::Texture,
//     pub texture_view: wgpu::TextureView,
// }

// impl<'a> FramePipelineState<'a> {
//     pub fn new(
//         constants: &'a RenderVideoConstants,
//         uniforms: &'a ProjectUniforms,
//         texture: &'a wgpu::Texture,
//     ) -> Self {
//         let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

//         Self {
//             constants,
//             uniforms,
//             texture,
//             texture_view,
//         }
//     }
// }

// pub struct FramePipelineEncoder {
//     pub encoder: wgpu::CommandEncoder,
// }

#[derive(Clone)]
pub struct RenderedFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub padded_bytes_per_row: u32,
    pub frame_number: u32,
    pub target_time_ns: u64,
}

// impl FramePipelineEncoder {
//     pub fn new(state: &FramePipelineState) -> Self {
//         Self {
//             encoder: state.constants.device.create_command_encoder(
//                 &(wgpu::CommandEncoderDescriptor {
//                     label: Some("Render Encoder"),
//                 }),
//             ),
//         }
//     }
// }

pub fn padded_bytes_per_row(output_size: (u32, u32)) -> u32 {
    // Calculate the aligned bytes per row
    let align = COPY_BYTES_PER_ROW_ALIGNMENT;
    let unpadded_bytes_per_row = output_size.0 * 4;
    let padding = (align - (unpadded_bytes_per_row % align)) % align;
    let padded_bytes_per_row = unpadded_bytes_per_row + padding;

    // Ensure the padded_bytes_per_row is a multiple of 4 (32 bits)
    (padded_bytes_per_row + 3) & !3
}

pub async fn finish_encoder(
    session: &mut RenderSession,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    uniforms: &ProjectUniforms,
    encoder: wgpu::CommandEncoder,
) -> Result<RenderedFrame, RenderingError> {
    let previous_frame = if let Some(prev) = session.pipelined_readback.take_pending() {
        Some(prev.wait(device).await?)
    } else {
        None
    };

    session.pipelined_readback.perform_resize_if_needed(device);

    let texture = if session.current_is_left {
        &session.textures.0
    } else {
        &session.textures.1
    };

    session
        .pipelined_readback
        .submit_readback(device, queue, texture, uniforms, encoder)?;

    if let Some(prev_frame) = previous_frame {
        return Ok(prev_frame);
    }

    let pending = session
        .pipelined_readback
        .take_pending()
        .expect("just submitted a readback");

    pending.wait(device).await
}

pub async fn finish_encoder_nv12(
    session: &mut RenderSession,
    nv12_converter: &mut RgbaToNv12Converter,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    uniforms: &ProjectUniforms,
    mut encoder: wgpu::CommandEncoder,
) -> Result<Nv12RenderedFrame, RenderingError> {
    let width = uniforms.output_size.0;
    let height = uniforms.output_size.1;

    let texture = if session.current_is_left {
        &session.textures.0
    } else {
        &session.textures.1
    };

    if let Some(pending) = nv12_converter.convert_and_readback(
        device,
        queue,
        &mut encoder,
        texture,
        width,
        height,
        uniforms.frame_number,
        uniforms.frame_rate,
    ) {
        queue.submit(std::iter::once(encoder.finish()));
        pending.wait(device).await
    } else {
        let rgba_frame = finish_encoder(session, device, queue, uniforms, encoder).await?;
        Ok(Nv12RenderedFrame {
            data: rgba_frame.data,
            width: rgba_frame.width,
            height: rgba_frame.height,
            y_stride: rgba_frame.padded_bytes_per_row,
            frame_number: rgba_frame.frame_number,
            target_time_ns: rgba_frame.target_time_ns,
        })
    }
}

pub async fn flush_pending_readback(
    session: &mut RenderSession,
    device: &wgpu::Device,
) -> Option<Result<RenderedFrame, RenderingError>> {
    if let Some(pending) = session.pipelined_readback.take_pending() {
        Some(pending.wait(device).await)
    } else {
        None
    }
}
