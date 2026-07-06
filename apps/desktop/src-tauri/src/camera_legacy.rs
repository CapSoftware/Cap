use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use cap_recording::FFmpegVideoFrame;
#[cfg(target_os = "macos")]
use cap_utils::macos_qos::{MacOsQosClass, set_current_thread_qos};
use flume::Sender;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::camera::{CameraPreviewState, MAX_CAMERA_SIZE, MIN_CAMERA_SIZE, is_low_spec_preview};
use crate::frame_ws::{WSFrame, create_watch_frame_ws};

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

const WS_PREVIEW_SURFACE_SCALE: u32 = 2;
// Same drag-resize hysteresis as the native preview: only rebuild the scaler
// and reallocate buffers when the target width crosses a 64px bucket.
const WS_PREVIEW_WIDTH_BUCKET: u32 = 64;
const WS_PREVIEW_MIN_WIDTH: u32 = 320;
const WS_PREVIEW_MAX_WIDTH: u32 = 960;
const WS_PREVIEW_MAX_HEIGHT: u32 = 540;
const WS_PREVIEW_BLUR_MAX_WIDTH: u32 = 640;
const WS_PREVIEW_BLUR_MAX_HEIGHT: u32 = 360;
const WS_PREVIEW_TARGET_FRAME_INTERVAL: Duration = Duration::from_micros(16_666);
const WS_PREVIEW_FRAME_INTERVAL_SLACK: Duration = Duration::from_millis(1);
const WS_BLUR_INFERENCE_INTERVAL: Duration = Duration::from_millis(150);

// Low-spec preview profile (mirrors the native path in camera.rs). Only used
// when `is_low_spec_preview()` is true (machines <= 8GB RAM detected at
// startup); high-spec machines use the constants above bit-for-bit.
const WS_PREVIEW_LOW_SPEC_MAX_WIDTH: u32 = 640;
const WS_PREVIEW_LOW_SPEC_MAX_HEIGHT: u32 = 360;
const WS_PREVIEW_LOW_SPEC_TARGET_FRAME_INTERVAL: Duration = Duration::from_micros(33_333);
const FRAME_POOL_LOW_SPEC_MAX: usize = 2;

fn preview_frame_due(last_preview_at: Option<Instant>, now: Instant) -> bool {
    // High-spec keeps the original 60fps target; low-spec paces at 30fps.
    let target_interval = if is_low_spec_preview() {
        WS_PREVIEW_LOW_SPEC_TARGET_FRAME_INTERVAL
    } else {
        WS_PREVIEW_TARGET_FRAME_INTERVAL
    };
    last_preview_at.is_none_or(|last| {
        now.saturating_duration_since(last) + WS_PREVIEW_FRAME_INTERVAL_SLACK >= target_interval
    })
}

const FRAME_POOL_MAX: usize = 4;

/// Frame-pool cap, lowered on low-spec to hold fewer ~2MB buffers in memory.
#[inline]
fn frame_pool_max() -> usize {
    if is_low_spec_preview() {
        FRAME_POOL_LOW_SPEC_MAX
    } else {
        FRAME_POOL_MAX
    }
}

// Reuses a previously-sent frame buffer once every WSFrame referencing it has
// been dropped (watch cell replaced + socket sends finished), eliminating the
// ~2MB allocation + page-fault churn per frame at steady state.
fn with_pooled_buffer(
    pool: &mut Vec<Arc<Vec<u8>>>,
    fill: impl FnOnce(&mut Vec<u8>),
) -> Arc<Vec<u8>> {
    for buf in pool.iter_mut() {
        if Arc::strong_count(buf) == 1
            && let Some(vec) = Arc::get_mut(buf)
        {
            vec.clear();
            fill(vec);
            return buf.clone();
        }
    }

    let mut vec = Vec::new();
    fill(&mut vec);
    let buf = Arc::new(vec);
    if pool.len() < frame_pool_max() {
        pool.push(buf.clone());
    }
    buf
}

// Copies rows without ffmpeg's stride padding so the payload is packed
// (stride == width * 4); this lets the frontend skip stride correction.
fn pack_rows(dst: &mut Vec<u8>, src: &[u8], width: u32, height: u32, stride: u32) {
    let row_bytes = (width as usize) * 4;
    let stride = stride as usize;
    let height = height as usize;
    dst.reserve(row_bytes * height);
    if stride == row_bytes {
        dst.extend_from_slice(&src[..row_bytes * height]);
    } else {
        for row in 0..height {
            let start = row * stride;
            dst.extend_from_slice(&src[start..start + row_bytes]);
        }
    }
}

fn scaled_preview_dimensions(width: u32, height: u32, state: &CameraPreviewState) -> (u32, u32) {
    let blur_enabled = state.background_blur != cap_project::BackgroundBlurMode::Off;
    let (max_width, max_height) = if is_low_spec_preview() {
        // Low-spec caps preview to 640x360 (blur is skipped on low-spec, so the
        // blur-vs-no-blur branch below does not apply).
        (
            WS_PREVIEW_LOW_SPEC_MAX_WIDTH,
            WS_PREVIEW_LOW_SPEC_MAX_HEIGHT,
        )
    } else if blur_enabled {
        (WS_PREVIEW_BLUR_MAX_WIDTH, WS_PREVIEW_BLUR_MAX_HEIGHT)
    } else {
        (WS_PREVIEW_MAX_WIDTH, WS_PREVIEW_MAX_HEIGHT)
    };
    let visible_width = (state.size.clamp(MIN_CAMERA_SIZE, MAX_CAMERA_SIZE) as u32)
        .saturating_mul(WS_PREVIEW_SURFACE_SCALE);
    let requested_width = visible_width
        .max(WS_PREVIEW_MIN_WIDTH)
        .div_ceil(WS_PREVIEW_WIDTH_BUCKET)
        .saturating_mul(WS_PREVIEW_WIDTH_BUCKET)
        .min(max_width);
    let width_scale = requested_width as f64 / width.max(1) as f64;
    let height_scale = max_height as f64 / height.max(1) as f64;
    let scale = width_scale.min(height_scale).min(1.0);
    let target_width = ((width as f64 * scale).round() as u32).max(1);
    let target_height = ((height as f64 * scale).round() as u32).max(1);
    (target_width, target_height)
}

pub async fn create_camera_preview_ws(
    state_rx: watch::Receiver<CameraPreviewState>,
) -> (Sender<FFmpegVideoFrame>, u16, CancellationToken) {
    let (camera_tx, camera_rx) = flume::bounded::<FFmpegVideoFrame>(1);
    let (frame_tx, frame_rx) = watch::channel::<Option<Arc<WSFrame>>>(None);
    let subscriber_count = Arc::new(AtomicUsize::new(0));
    let frame_tx_clone = frame_tx.clone();
    let thread_subscriber_count = subscriber_count.clone();
    std::thread::spawn(move || {
        use ffmpeg::format::Pixel;

        #[cfg(target_os = "macos")]
        {
            let result = set_current_thread_qos(MacOsQosClass::UserInteractive);
            if result != 0 {
                tracing::warn!(result, "pthread_set_qos_class_self_np failed");
            }
        }
        #[cfg(windows)]
        {
            use windows::Win32::System::Threading::{
                GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL,
            };
            if let Err(err) =
                unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL) }
            {
                tracing::warn!("SetThreadPriority failed: {err}");
            }
        }

        let mut converter: Option<(Pixel, ffmpeg::software::scaling::Context)> = None;
        let mut reusable_frame: Option<ffmpeg::util::frame::Video> = None;
        let mut state_rx = state_rx;

        let mut blur_state = WsBlurState::new();
        let mut last_preview_at = None;
        let mut frame_pool: Vec<Arc<Vec<u8>>> = Vec::new();
        let mut frame_counter: u32 = 0;
        let mut idle = true;

        while let Ok(raw_frame) = camera_rx.recv() {
            let mut frame = raw_frame.inner;

            while let Ok(newer) = camera_rx.try_recv() {
                frame = newer.inner;
            }

            // With no connected ws clients, skip all conversion work and
            // release retained resources; the cleared watch cell also stops
            // stale frames from being replayed to the next connection.
            if thread_subscriber_count.load(Ordering::Acquire) == 0 {
                if !idle {
                    idle = true;
                    converter = None;
                    reusable_frame = None;
                    frame_pool.clear();
                    blur_state.release();
                    last_preview_at = None;
                    let _previous_frame = frame_tx_clone.send_replace(None);
                }
                continue;
            }
            idle = false;

            let now = Instant::now();
            if !preview_frame_due(last_preview_at, now) {
                continue;
            }
            last_preview_at = Some(now);

            let state = state_rx.borrow_and_update().clone();
            let blur_mode = state.background_blur;
            let blur_enabled = blur_mode != cap_project::BackgroundBlurMode::Off;
            let effects_mode = match blur_mode {
                cap_project::BackgroundBlurMode::Off | cap_project::BackgroundBlurMode::Light => {
                    cap_camera_effects::BlurMode::Light
                }
                cap_project::BackgroundBlurMode::Heavy => cap_camera_effects::BlurMode::Heavy,
            };

            let (target_width, target_height) =
                scaled_preview_dimensions(frame.width(), frame.height(), &state);
            let needs_convert = frame.format() != Pixel::RGBA
                || frame.width() != target_width
                || frame.height() != target_height;

            if !blur_enabled {
                blur_state.release();
            }

            if needs_convert {
                let ctx = match &mut converter {
                    Some((format, ctx))
                        if *format == frame.format()
                            && ctx.input().width == frame.width()
                            && ctx.input().height == frame.height()
                            && ctx.output().width == target_width
                            && ctx.output().height == target_height =>
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

                let width = out_frame.width();
                let height = out_frame.height();
                let src_stride = out_frame.stride(0) as u32;
                let data = if blur_enabled {
                    blur_state.process(
                        out_frame.data(0),
                        width,
                        height,
                        src_stride,
                        effects_mode,
                        &mut frame_pool,
                    )
                } else {
                    None
                }
                .unwrap_or_else(|| {
                    with_pooled_buffer(&mut frame_pool, |vec| {
                        pack_rows(vec, out_frame.data(0), width, height, src_stride)
                    })
                });

                frame_counter = frame_counter.wrapping_add(1);
                let _previous_frame = frame_tx_clone.send_replace(Some(Arc::new(WSFrame {
                    data,
                    width,
                    height,
                    stride: width * 4,
                    frame_number: frame_counter,
                    target_time_ns: 0,
                    format: crate::frame_ws::WSFrameFormat::Rgba,
                    created_at: Instant::now(),
                })));
            } else {
                let width = frame.width();
                let height = frame.height();
                let src_stride = frame.stride(0) as u32;
                let data = if blur_enabled {
                    blur_state.process(
                        frame.data(0),
                        width,
                        height,
                        src_stride,
                        effects_mode,
                        &mut frame_pool,
                    )
                } else {
                    None
                }
                .unwrap_or_else(|| {
                    with_pooled_buffer(&mut frame_pool, |vec| {
                        pack_rows(vec, frame.data(0), width, height, src_stride)
                    })
                });

                frame_counter = frame_counter.wrapping_add(1);
                let _previous_frame = frame_tx_clone.send_replace(Some(Arc::new(WSFrame {
                    data,
                    width,
                    height,
                    stride: width * 4,
                    frame_number: frame_counter,
                    target_time_ns: 0,
                    format: crate::frame_ws::WSFrameFormat::Rgba,
                    created_at: Instant::now(),
                })));
            }
        }
    });
    let (camera_ws_port, _shutdown) = create_watch_frame_ws(frame_rx, subscriber_count).await;

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

    // Drops the dedicated wgpu device, ONNX session, and readback buffers as
    // soon as blur is off; re-enabling re-runs the lazy init.
    fn release(&mut self) {
        if self.processor.is_some() {
            self.processor = None;
            tracing::info!("Released WebSocket camera blur resources");
        }
        self.init_attempted = false;
    }

    fn process(
        &mut self,
        rgba_data: &[u8],
        width: u32,
        height: u32,
        stride: u32,
        mode: cap_camera_effects::BlurMode,
        pool: &mut Vec<Arc<Vec<u8>>>,
    ) -> Option<Arc<Vec<u8>>> {
        // Low-spec: never spin up the headless ONNX/wgpu blur processor (the
        // heaviest preview cost). Returning `None` makes the caller fall back to
        // packing the raw camera rows, so the preview is unblurred but cheap.
        // The UI blur toggle is unaffected; it just has no visual effect here.
        // Same fallback when crash recovery disabled blur: bail before creating
        // any GPU resources at all, since the whole blur stack is suspect on
        // this machine.
        if is_low_spec_preview() || cap_camera_effects::blur_disabled() {
            return None;
        }

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
                bytes_per_row: Some(stride),
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
            pool,
        );
        let curr_data = try_drain_readback(
            &mut res.readbacks.as_mut().unwrap().2[current_idx],
            width,
            height,
            bytes_per_row_aligned,
            pool,
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

        blurred_out
    }
}

fn try_drain_readback(
    readback: &mut WsReadback,
    width: u32,
    height: u32,
    bytes_per_row_aligned: u32,
    pool: &mut Vec<Arc<Vec<u8>>>,
) -> Option<Arc<Vec<u8>>> {
    let WsReadbackState::InFlight(status) = &readback.state else {
        return None;
    };
    match status.load(Ordering::Acquire) {
        WS_READBACK_READY_OK => {
            let slice = readback.buffer.slice(..);
            let data = slice.get_mapped_range();
            let row_bytes = (width * 4) as usize;
            let out = with_pooled_buffer(pool, |vec| {
                vec.reserve(row_bytes * height as usize);
                for row in 0..height as usize {
                    let start = row * bytes_per_row_aligned as usize;
                    vec.extend_from_slice(&data[start..start + row_bytes]);
                }
            });
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
    // Arm the sentinel's blur marker around the blur-dedicated wgpu
    // adapter/device setup too, so a native death here is attributed to blur.
    // Deliberately not `enter_gpu_init_phase`: that would cross-trigger WARP
    // software-graphics recovery and cripple the editor for a blur-only crash.
    crate::crash_sentinel::enter_blur_session();
    struct BlurSessionGuard;
    impl Drop for BlurSessionGuard {
        fn drop(&mut self) {
            crate::crash_sentinel::exit_blur_session();
        }
    }
    let _guard = BlurSessionGuard;

    let instance = cap_rendering::create_wgpu_instance_sync();
    let force_software_adapter = cap_rendering::force_software_wgpu_adapter();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::LowPower,
        force_fallback_adapter: force_software_adapter,
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

    let mut processor =
        cap_camera_effects::BlurProcessor::new(&device, wgpu::TextureFormat::Rgba8Unorm).ok()?;
    processor.set_inference_interval(WS_BLUR_INFERENCE_INTERVAL);

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
