use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Instant;

use cap_recording::FFmpegVideoFrame;
use flume::Sender;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::frame_ws::{WSFrame, create_frame_ws};

const WS_READBACK_PENDING: u8 = 0;
const WS_READBACK_READY_OK: u8 = 1;
const WS_READBACK_READY_ERR: u8 = 2;

enum WsReadbackState {
    Idle,
    InFlight(Arc<AtomicU8>),
}

struct WsReadback {
    buffer: wgpu::Buffer,
    state: WsReadbackState,
}

const WS_PREVIEW_MAX_WIDTH: u32 = 640;
const WS_PREVIEW_MAX_HEIGHT: u32 = 360;

pub async fn create_camera_preview_ws(
    blur_rx: watch::Receiver<cap_project::BackgroundBlurMode>,
) -> (Sender<FFmpegVideoFrame>, u16, CancellationToken) {
    let (camera_tx, camera_rx) = flume::bounded::<FFmpegVideoFrame>(4);
    let (frame_tx, _) = tokio::sync::broadcast::channel::<WSFrame>(4);
    let frame_tx_clone = frame_tx.clone();
    std::thread::spawn(move || {
        use ffmpeg::format::Pixel;

        let mut converter: Option<(Pixel, ffmpeg::software::scaling::Context)> = None;
        let mut reusable_frame: Option<ffmpeg::util::frame::Video> = None;
        let mut blur_rx = blur_rx;

        let mut blur_state = WsBlurState::new();

        while let Ok(raw_frame) = camera_rx.recv() {
            let mut frame = raw_frame.inner;

            while let Ok(newer) = camera_rx.try_recv() {
                frame = newer.inner;
            }

            let blur_mode = *blur_rx.borrow_and_update();
            let blur_enabled = blur_mode != cap_project::BackgroundBlurMode::Off;
            let effects_mode = match blur_mode {
                cap_project::BackgroundBlurMode::Off | cap_project::BackgroundBlurMode::Light => {
                    cap_camera_effects::BlurMode::Light
                }
                cap_project::BackgroundBlurMode::Heavy => cap_camera_effects::BlurMode::Heavy,
            };

            let needs_convert = frame.format() != Pixel::RGBA
                || frame.width() > WS_PREVIEW_MAX_WIDTH
                || frame.height() > WS_PREVIEW_MAX_HEIGHT;

            if needs_convert {
                let target_width = WS_PREVIEW_MAX_WIDTH.min(frame.width());
                let target_height =
                    (target_width as f64 / (frame.width() as f64 / frame.height() as f64)) as u32;

                let ctx = match &mut converter {
                    Some((format, ctx))
                        if *format == frame.format()
                            && ctx.input().width == frame.width()
                            && ctx.input().height == frame.height() =>
                    {
                        ctx
                    }
                    _ => {
                        let Ok(new_converter) = ffmpeg::software::scaling::Context::get(
                            frame.format(),
                            frame.width(),
                            frame.height(),
                            Pixel::RGBA,
                            target_width,
                            target_height,
                            ffmpeg::software::scaling::flag::Flags::FAST_BILINEAR,
                        ) else {
                            continue;
                        };

                        reusable_frame = None;
                        &mut converter.insert((frame.format(), new_converter)).1
                    }
                };

                let out_frame = reusable_frame.get_or_insert_with(|| {
                    ffmpeg::util::frame::Video::new(
                        Pixel::RGBA,
                        ctx.output().width,
                        ctx.output().height,
                    )
                });

                if ctx.run(&frame, out_frame).is_err() {
                    continue;
                }

                let (data, width, height, stride) = if blur_enabled {
                    match blur_state.process(
                        out_frame.data(0),
                        out_frame.width(),
                        out_frame.height(),
                        out_frame.stride(0) as u32,
                        effects_mode,
                    ) {
                        Some(blurred) => blurred,
                        None => (
                            std::sync::Arc::new(out_frame.data(0).to_vec()),
                            out_frame.width(),
                            out_frame.height(),
                            out_frame.stride(0) as u32,
                        ),
                    }
                } else {
                    (
                        std::sync::Arc::new(out_frame.data(0).to_vec()),
                        out_frame.width(),
                        out_frame.height(),
                        out_frame.stride(0) as u32,
                    )
                };

                frame_tx_clone
                    .send(WSFrame {
                        data,
                        width,
                        height,
                        stride,
                        frame_number: 0,
                        target_time_ns: 0,
                        format: crate::frame_ws::WSFrameFormat::Rgba,
                        created_at: Instant::now(),
                    })
                    .ok();
            } else {
                let (data, width, height, stride) = if blur_enabled {
                    match blur_state.process(
                        frame.data(0),
                        frame.width(),
                        frame.height(),
                        frame.stride(0) as u32,
                        effects_mode,
                    ) {
                        Some(blurred) => blurred,
                        None => (
                            std::sync::Arc::new(frame.data(0).to_vec()),
                            frame.width(),
                            frame.height(),
                            frame.stride(0) as u32,
                        ),
                    }
                } else {
                    (
                        std::sync::Arc::new(frame.data(0).to_vec()),
                        frame.width(),
                        frame.height(),
                        frame.stride(0) as u32,
                    )
                };

                frame_tx_clone
                    .send(WSFrame {
                        data,
                        width,
                        height,
                        stride,
                        frame_number: 0,
                        target_time_ns: 0,
                        format: crate::frame_ws::WSFrameFormat::Rgba,
                        created_at: Instant::now(),
                    })
                    .ok();
            }
        }
    });
    let (camera_ws_port, _shutdown) = create_frame_ws(frame_tx).await;

    (camera_tx, camera_ws_port, _shutdown)
}

struct WsBlurState {
    processor: Option<WsBlurResources>,
    init_attempted: bool,
}

struct WsBlurResources {
    device: wgpu::Device,
    queue: wgpu::Queue,
    processor: cap_camera_effects::BlurProcessor,
    source_texture: Option<(u32, u32, wgpu::Texture)>,
    readbacks: Option<(u32, u32, [WsReadback; 2])>,
    current_idx: usize,
}

impl WsBlurState {
    fn new() -> Self {
        Self {
            processor: None,
            init_attempted: false,
        }
    }

    fn process(
        &mut self,
        rgba_data: &[u8],
        width: u32,
        height: u32,
        _stride: u32,
        mode: cap_camera_effects::BlurMode,
    ) -> Option<(Arc<Vec<u8>>, u32, u32, u32)> {
        if !self.init_attempted {
            self.init_attempted = true;
            self.processor = init_headless_blur();
        }

        let res = self.processor.as_mut()?;

        let src = match &res.source_texture {
            Some((w, h, t)) if *w == width && *h == height => t,
            _ => {
                let tex = res.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("WS Blur Source"),
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
                        | wgpu::TextureUsages::COPY_SRC,
                    view_formats: &[],
                });
                res.source_texture = Some((width, height, tex));
                &res.source_texture.as_ref().unwrap().2
            }
        };

        res.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: src,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba_data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        let bytes_per_row_aligned = (width * 4 + 255) & !255;
        let buf_size = (bytes_per_row_aligned * height) as u64;

        let readbacks_match = matches!(
            &res.readbacks,
            Some((w, h, _)) if *w == width && *h == height
        );
        if !readbacks_match {
            let make_buf = |label: &str| {
                res.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(label),
                    size: buf_size,
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                })
            };
            let readbacks = [
                WsReadback {
                    buffer: make_buf("WS Blur Readback 0"),
                    state: WsReadbackState::Idle,
                },
                WsReadback {
                    buffer: make_buf("WS Blur Readback 1"),
                    state: WsReadbackState::Idle,
                },
            ];
            res.readbacks = Some((width, height, readbacks));
            res.current_idx = 0;
        }

        let _ = res.device.poll(wgpu::PollType::Poll);

        let current_idx = res.current_idx;
        let prev_idx = 1 - current_idx;

        let prev_data = try_drain_readback(
            &mut res.readbacks.as_mut().unwrap().2[prev_idx],
            width,
            height,
            bytes_per_row_aligned,
        );
        let curr_data = try_drain_readback(
            &mut res.readbacks.as_mut().unwrap().2[current_idx],
            width,
            height,
            bytes_per_row_aligned,
        );
        let blurred_out = prev_data.or(curr_data);

        let issue_idx = if matches!(
            res.readbacks.as_ref().unwrap().2[current_idx].state,
            WsReadbackState::Idle
        ) {
            Some(current_idx)
        } else if matches!(
            res.readbacks.as_ref().unwrap().2[prev_idx].state,
            WsReadbackState::Idle
        ) {
            Some(prev_idx)
        } else {
            None
        };

        if let Some(idx) = issue_idx {
            let output = res.processor.process(&res.device, &res.queue, src, mode);

            let mut encoder = res
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("WS Blur Copy"),
                });

            encoder.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo {
                    texture: output,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyBufferInfo {
                    buffer: &res.readbacks.as_ref().unwrap().2[idx].buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(bytes_per_row_aligned),
                        rows_per_image: Some(height),
                    },
                },
                wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
            );

            res.queue.submit(std::iter::once(encoder.finish()));

            let status = Arc::new(AtomicU8::new(WS_READBACK_PENDING));
            let status_cb = status.clone();
            res.readbacks.as_ref().unwrap().2[idx]
                .buffer
                .slice(..)
                .map_async(wgpu::MapMode::Read, move |result| {
                    let code = if result.is_ok() {
                        WS_READBACK_READY_OK
                    } else {
                        WS_READBACK_READY_ERR
                    };
                    status_cb.store(code, Ordering::Release);
                });

            res.readbacks.as_mut().unwrap().2[idx].state = WsReadbackState::InFlight(status);
            res.current_idx = 1 - idx;
        }

        blurred_out.map(|out| (Arc::new(out), width, height, width * 4))
    }
}

fn try_drain_readback(
    readback: &mut WsReadback,
    width: u32,
    height: u32,
    bytes_per_row_aligned: u32,
) -> Option<Vec<u8>> {
    let WsReadbackState::InFlight(status) = &readback.state else {
        return None;
    };
    match status.load(Ordering::Acquire) {
        WS_READBACK_READY_OK => {
            let slice = readback.buffer.slice(..);
            let data = slice.get_mapped_range();
            let row_bytes = (width * 4) as usize;
            let mut out = Vec::with_capacity(row_bytes * height as usize);
            for row in 0..height as usize {
                let start = row * bytes_per_row_aligned as usize;
                out.extend_from_slice(&data[start..start + row_bytes]);
            }
            drop(data);
            readback.buffer.unmap();
            readback.state = WsReadbackState::Idle;
            Some(out)
        }
        WS_READBACK_READY_ERR => {
            readback.state = WsReadbackState::Idle;
            None
        }
        _ => None,
    }
}

fn init_headless_blur() -> Option<WsBlurResources> {
    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::LowPower,
        force_fallback_adapter: false,
        compatible_surface: None,
    }))
    .ok()?;

    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("WS Blur Device"),
        required_features: wgpu::Features::empty(),
        required_limits:
            wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
        memory_hints: Default::default(),
        trace: wgpu::Trace::Off,
    }))
    .ok()?;

    let processor =
        cap_camera_effects::BlurProcessor::new(&device, wgpu::TextureFormat::Rgba8Unorm).ok()?;

    tracing::info!("WebSocket camera blur processor initialized (headless)");

    Some(WsBlurResources {
        device,
        queue,
        processor,
        source_texture: None,
        readbacks: None,
        current_idx: 0,
    })
}
