use std::sync::Arc;
use tokio::sync::oneshot;
use wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;

use crate::{ProjectUniforms, RenderingError};

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

        loop {
            match self.rx.try_recv() {
                Ok(result) => {
                    result?;
                    break;
                }
                Err(oneshot::error::TryRecvError::Empty) => {
                    match device.poll(wgpu::PollType::Poll) {
                        Ok(maintained) => {
                            if maintained.is_queue_empty() {
                                break;
                            }
                        }
                        Err(e) => return Err(e.into()),
                    }
                    poll_count += 1;
                    if poll_count.is_multiple_of(3) {
                        tokio::task::yield_now().await;
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
        }
    }

    pub fn ensure_size(&mut self, device: &wgpu::Device, required_size: u64) {
        if self.buffer_size < required_size {
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
        }
    }

    pub fn update_texture_size(&mut self, device: &wgpu::Device, width: u32, height: u32) {
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
    let previous_pending = session.pipelined_readback.take_pending();

    let texture = if session.current_is_left {
        &session.textures.0
    } else {
        &session.textures.1
    };

    session
        .pipelined_readback
        .submit_readback(device, queue, texture, uniforms, encoder)?;

    let result = if let Some(pending) = previous_pending {
        pending.wait(device).await?
    } else {
        let pending = session
            .pipelined_readback
            .take_pending()
            .expect("just submitted a readback");
        let frame = pending.wait(device).await?;

        let prime_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Pipeline Priming Encoder"),
        });
        session.pipelined_readback.submit_readback(
            device,
            queue,
            texture,
            uniforms,
            prime_encoder,
        )?;

        frame
    };

    Ok(result)
}
