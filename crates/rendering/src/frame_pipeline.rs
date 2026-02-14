use std::sync::Arc;
use std::time::Instant;
use tokio::sync::oneshot;
use wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;

use crate::{ProjectUniforms, RenderingError};

const GPU_BUFFER_WAIT_TIMEOUT_SECS: u64 = 10;

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
