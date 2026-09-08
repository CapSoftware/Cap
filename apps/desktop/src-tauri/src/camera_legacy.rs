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
use crate::frame_ws::{WSFrame, WSFrameFormat, create_watch_frame_ws_with_instant_tracking};

const WS_READBACK_PENDING: u8 = 0;
const WS_READBACK_READY_OK: u8 = 1;
const WS_READBACK_READY_ERR: u8 = 2;

const WS_READBACK_CONSUMED: u8 = 3;

#[cfg(target_os = "linux")]
type OutputReceipt = Option<crate::linux_instant_camera::FrameReceipt>;
#[cfg(not(target_os = "linux"))]
#[derive(Default)]
struct PreviewReceipt;
#[cfg(not(target_os = "linux"))]
type OutputReceipt = PreviewReceipt;

struct ReadbackTicket {
    status: Arc<AtomicU8>,
    receipt: OutputReceipt,
}

impl ReadbackTicket {
    fn new(receipt: OutputReceipt) -> Self {
        Self {
            status: Arc::new(AtomicU8::new(WS_READBACK_PENDING)),
            receipt,
        }
    }

    fn take_ready(&mut self) -> Result<Option<OutputReceipt>, String> {
        match self.status.load(Ordering::Acquire) {
            WS_READBACK_READY_OK => {
                self.status.store(WS_READBACK_CONSUMED, Ordering::Release);
                Ok(Some(std::mem::take(&mut self.receipt)))
            }
            WS_READBACK_READY_ERR => {
                self.status.store(WS_READBACK_CONSUMED, Ordering::Release);
                Err("Requested camera blur GPU readback failed".into())
            }
            _ => Ok(None),
        }
    }
}

enum WsReadbackState {
    Idle,
    InFlight(ReadbackTicket),
}

struct WsReadback {
    buffer: wgpu::Buffer,
    state: WsReadbackState,
}

struct BlurInput<'a> {
    rgba: &'a [u8],
    width: u32,
    height: u32,
    stride: u32,
    mode: cap_camera_effects::BlurMode,
    receipt: OutputReceipt,
}

struct BlurredFrame {
    data: Arc<Vec<u8>>,
    #[cfg(target_os = "linux")]
    receipt: Option<crate::linux_instant_camera::FrameReceipt>,
}

pub struct CameraPreviewWs {
    pub sender: Sender<FFmpegVideoFrame>,
    pub port: u16,
    pub shutdown: CancellationToken,
    #[cfg(target_os = "linux")]
    pub processing: crate::linux_instant_camera::ProcessingFactory,
}

#[cfg(target_os = "linux")]
enum WorkerEvent<F, C> {
    Frame(F),
    Command(C),
    Closed,
    Tick,
}

#[cfg(target_os = "linux")]
fn next_worker_event<F, C>(
    frames: &flume::Receiver<F>,
    commands: &flume::Receiver<C>,
    timeout: Option<Duration>,
) -> WorkerEvent<F, C> {
    let selector = flume::Selector::new()
        .recv(frames, |result| {
            result.map_or(WorkerEvent::Closed, WorkerEvent::Frame)
        })
        .recv(commands, |result| {
            result.map_or(WorkerEvent::Closed, WorkerEvent::Command)
        });
    match timeout {
        Some(timeout) => selector.wait_timeout(timeout).unwrap_or(WorkerEvent::Tick),
        None => selector.wait(),
    }
}

fn processing_needed(preview: bool, recording: bool) -> bool {
    preview || recording
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

fn pack_plane_rows(dst: &mut Vec<u8>, src: &[u8], row_bytes: usize, height: u32, stride: u32) {
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

fn pack_rgba_rows(dst: &mut Vec<u8>, frame: &ffmpeg::util::frame::Video) {
    pack_plane_rows(
        dst,
        frame.data(0),
        frame.width() as usize * 4,
        frame.height(),
        frame.stride(0) as u32,
    );
}

fn pack_nv12_planes(dst: &mut Vec<u8>, frame: &ffmpeg::util::frame::Video) {
    let width = frame.width() as usize;
    pack_plane_rows(
        dst,
        frame.data(0),
        width,
        frame.height(),
        frame.stride(0) as u32,
    );
    pack_plane_rows(
        dst,
        frame.data(1),
        width,
        frame.height() / 2,
        frame.stride(1) as u32,
    );
}

fn prepare_ws_data(
    frame: &ffmpeg::util::frame::Video,
    format: WSFrameFormat,
    frame_pool: &mut Vec<Arc<Vec<u8>>>,
) -> (Arc<Vec<u8>>, u32) {
    match format {
        WSFrameFormat::Rgba => (
            with_pooled_buffer(frame_pool, |vec| pack_rgba_rows(vec, frame)),
            frame.width() * 4,
        ),
        WSFrameFormat::Nv12 { .. } => (
            with_pooled_buffer(frame_pool, |vec| pack_nv12_planes(vec, frame)),
            frame.width(),
        ),
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
) -> CameraPreviewWs {
    let (camera_tx, camera_rx) = flume::bounded::<FFmpegVideoFrame>(1);
    #[cfg(target_os = "linux")]
    let (processing, commands) = crate::linux_instant_camera::processing_channel();
    let (frame_tx, frame_rx) = watch::channel::<Option<Arc<WSFrame>>>(None);
    let subscriber_count = Arc::new(AtomicUsize::new(0));
    let instant_subscriber_count = Arc::new(AtomicUsize::new(0));
    let frame_tx_clone = frame_tx.clone();
    let thread_subscriber_count = subscriber_count.clone();
    let thread_instant_subscriber_count = instant_subscriber_count.clone();
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

        let mut converter: Option<(Pixel, Pixel, ffmpeg::software::scaling::Context)> = None;
        let mut reusable_frame: Option<ffmpeg::util::frame::Video> = None;
        let mut state_rx = state_rx;

        let mut blur_state = WsBlurState::new();
        let mut last_preview_at = None;
        let mut frame_pool: Vec<Arc<Vec<u8>>> = Vec::new();
        let mut frame_counter: u32 = 0;
        let mut idle = true;
        #[cfg(target_os = "linux")]
        let mut recording: Option<crate::linux_instant_camera::RecordingWork> = None;
        #[cfg(target_os = "linux")]
        let mut warm_until: Option<Instant> = None;
        loop {
            #[cfg(target_os = "linux")]
            if recording.as_ref().is_some_and(|work| work.cancelled()) {
                recording = None;
                warm_until = Some(Instant::now() + Duration::from_millis(500));
            }
            #[cfg(target_os = "linux")]
            if let Some(deadline) = warm_until {
                if thread_subscriber_count.load(Ordering::Acquire) > 0 {
                    warm_until = None;
                } else if Instant::now() >= deadline {
                    converter = None;
                    reusable_frame = None;
                    frame_pool.clear();
                    blur_state.release();
                    last_preview_at = None;
                    idle = true;
                    warm_until = None;
                    let _previous_frame = frame_tx_clone.send_replace(None);
                }
            }
            let input = &camera_rx;
            #[cfg(target_os = "linux")]
            let input = recording.as_ref().map_or(input, |work| &work.frames);
            #[cfg(target_os = "linux")]
            let raw_frame = {
                let timeout = if recording.is_some() {
                    Some(Duration::from_millis(50))
                } else {
                    warm_until.map(|deadline| deadline.saturating_duration_since(Instant::now()))
                };
                let event = next_worker_event(input, &commands, timeout);
                match event {
                    WorkerEvent::Frame(frame) => frame,
                    WorkerEvent::Command(work) => {
                        if work.cancelled() {
                            continue;
                        }
                        if recording.is_some() {
                            work.fail("Another camera processing lease is active");
                            continue;
                        }
                        warm_until = None;
                        blur_state.begin_recording_epoch();
                        last_preview_at = None;
                        recording = Some(*work);
                        continue;
                    }
                    WorkerEvent::Closed => break,
                    WorkerEvent::Tick => continue,
                }
            };
            #[cfg(not(target_os = "linux"))]
            let raw_frame = match input.recv() {
                Ok(frame) => frame,
                Err(_) => break,
            };
            let mut raw_frame = raw_frame;
            while let Ok(newer) = input.try_recv() {
                raw_frame = newer;
            }
            #[cfg(target_os = "linux")]
            if let Some(work) = &recording {
                match work.accepts(raw_frame.timestamp) {
                    Ok(true) => {}
                    Ok(false) => continue,
                    Err(error) => {
                        work.fail(error);
                        continue;
                    }
                }
            }
            #[cfg(target_os = "linux")]
            let capture_timestamp = raw_frame.timestamp;
            let frame = raw_frame.inner;
            let instant_preview_active =
                thread_instant_subscriber_count.load(Ordering::Acquire) > 0;
            let ws_active = thread_subscriber_count.load(Ordering::Acquire) > 0;
            #[cfg(target_os = "linux")]
            let recording_active = recording.is_some();
            #[cfg(not(target_os = "linux"))]
            let recording_active = false;
            let processing_active = processing_needed(ws_active, recording_active);
            if !processing_active {
                #[cfg(target_os = "linux")]
                if warm_until.is_some() {
                    continue;
                }
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
            #[cfg(target_os = "linux")]
            let state = recording.as_ref().map_or(state, |work| work.state.clone());
            let blur_mode = state.background_blur;
            let blur_enabled = blur_mode != cap_project::BackgroundBlurMode::Off;
            let effects_mode = match blur_mode {
                cap_project::BackgroundBlurMode::Off | cap_project::BackgroundBlurMode::Light => {
                    cap_camera_effects::BlurMode::Light
                }
                cap_project::BackgroundBlurMode::Heavy => cap_camera_effects::BlurMode::Heavy,
            };
            let (mut target_width, mut target_height) =
                scaled_preview_dimensions(frame.width(), frame.height(), &state);
            let use_nv12 = cfg!(target_os = "macos")
                && instant_preview_active
                && !blur_enabled
                && frame.format() == Pixel::NV12;
            let (output_pixel, output_format) = if use_nv12 {
                target_width = target_width.max(2) & !1;
                target_height = target_height.max(2) & !1;
                (
                    Pixel::NV12,
                    WSFrameFormat::Nv12 {
                        full_range: frame.color_range() == ffmpeg::color::Range::JPEG,
                    },
                )
            } else {
                (Pixel::RGBA, WSFrameFormat::Rgba)
            };
            let needs_convert = frame.format() != output_pixel
                || frame.width() != target_width
                || frame.height() != target_height;
            if !blur_enabled {
                blur_state.release();
            }
            let output_frame = if needs_convert {
                let ctx = match &mut converter {
                    Some((input_format, cached_output_format, ctx))
                        if *input_format == frame.format()
                            && *cached_output_format == output_pixel
                            && ctx.input().width == frame.width()
                            && ctx.input().height == frame.height()
                            && ctx.output().width == target_width
                            && ctx.output().height == target_height =>
                    {
                        ctx
                    }
                    _ => {
                        let new_converter = ffmpeg::software::scaling::Context::get(
                            frame.format(),
                            frame.width(),
                            frame.height(),
                            output_pixel,
                            target_width,
                            target_height,
                            ffmpeg::software::scaling::flag::Flags::FAST_BILINEAR,
                        );
                        let Ok(new_converter) = new_converter else {
                            #[cfg(target_os = "linux")]
                            if let Some(work) = &recording {
                                work.fail("Camera pixel conversion is unavailable");
                            }
                            continue;
                        };
                        reusable_frame = None;
                        &mut converter
                            .insert((frame.format(), output_pixel, new_converter))
                            .2
                    }
                };
                let out_frame = reusable_frame.get_or_insert_with(|| {
                    ffmpeg::util::frame::Video::new(
                        output_pixel,
                        ctx.output().width,
                        ctx.output().height,
                    )
                });
                if ctx.run(&frame, out_frame).is_err() {
                    #[cfg(target_os = "linux")]
                    if let Some(work) = &recording {
                        work.fail("Camera pixel conversion failed");
                    }
                    continue;
                }
                &*out_frame
            } else {
                &frame
            };
            let width = output_frame.width();
            let height = output_frame.height();
            #[cfg(target_os = "linux")]
            let receipt = recording
                .as_ref()
                .map(|work| work.receipt(capture_timestamp, (width, height)));
            let blurred = if blur_enabled {
                blur_state.process(
                    BlurInput {
                        rgba: output_frame.data(0),
                        width,
                        height,
                        stride: output_frame.stride(0) as u32,
                        mode: effects_mode,
                        #[cfg(target_os = "linux")]
                        receipt: receipt.clone(),
                        #[cfg(not(target_os = "linux"))]
                        receipt: PreviewReceipt,
                    },
                    &mut frame_pool,
                )
            } else {
                Ok(None)
            };
            #[cfg(target_os = "linux")]
            if let Some(work) = &recording {
                if !blur_enabled {
                    let (data, _) = prepare_ws_data(output_frame, output_format, &mut frame_pool);
                    work.publish(&data, receipt.unwrap());
                } else {
                    match &blurred {
                        Ok(Some(output)) => {
                            if let Some(receipt) = output.receipt.clone() {
                                work.publish(&output.data, receipt);
                            }
                        }
                        Ok(None) => {}
                        Err(error) => work.fail(error.clone()),
                    }
                }
            }
            if ws_active {
                let (data, stride) = blurred
                    .ok()
                    .flatten()
                    .map(|frame| (frame.data, width * 4))
                    .unwrap_or_else(|| {
                        prepare_ws_data(output_frame, output_format, &mut frame_pool)
                    });
                frame_counter = frame_counter.wrapping_add(1);
                let _previous_frame = frame_tx_clone.send_replace(Some(Arc::new(WSFrame {
                    data,
                    width,
                    height,
                    stride,
                    frame_number: frame_counter,
                    target_time_ns: 0,
                    format: output_format,
                    created_at: Instant::now(),
                })));
            } else {
                frame_tx_clone.send_if_modified(|frame| frame.take().is_some());
            }
        }
    });
    let (camera_ws_port, _shutdown) = create_watch_frame_ws_with_instant_tracking(
        frame_rx,
        subscriber_count,
        instant_subscriber_count,
    )
    .await;

    CameraPreviewWs {
        sender: camera_tx,
        port: camera_ws_port,
        shutdown: _shutdown,
        #[cfg(target_os = "linux")]
        processing,
    }
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

    #[cfg(target_os = "linux")]
    fn begin_recording_epoch(&mut self) {
        if let Some(resources) = &mut self.processor {
            resources.readbacks = None;
            resources.current_idx = 0;
            resources.processor.reset_mask_history();
        } else {
            self.init_attempted = false;
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
        input: BlurInput<'_>,
        pool: &mut Vec<Arc<Vec<u8>>>,
    ) -> Result<Option<BlurredFrame>, String> {
        let BlurInput {
            rgba: rgba_data,
            width,
            height,
            stride,
            mode,
            receipt,
        } = input;
        // Idle preview keeps its compatibility fallback; recording requires this error to stay terminal.
        if is_low_spec_preview() || cap_camera_effects::blur_disabled() {
            return Err("Requested camera blur is disabled or unavailable on this device".into());
        }

        if !self.init_attempted {
            self.init_attempted = true;
            self.processor = Some(init_headless_blur()?);
        }

        let res = self
            .processor
            .as_mut()
            .ok_or("Requested camera blur initialization failed")?;

        #[cfg(target_os = "linux")]
        if receipt.as_ref().is_some_and(|receipt| matches!(receipt.timestamp,
            cap_timestamp::Timestamp::Instant(captured) if captured.elapsed() > Duration::from_secs(1))) {
            return Ok(None);
        }

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
        #[cfg(target_os = "linux")]
        let require_verified_output = receipt.is_some();
        #[cfg(not(target_os = "linux"))]
        let require_verified_output = false;
        let blurred_out = if require_verified_output {
            prev_data?.or(curr_data?)
        } else {
            prev_data.ok().flatten().or(curr_data.ok().flatten())
        };

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

            #[cfg(target_os = "linux")]
            let receipt = receipt.map(|mut receipt| {
                receipt.blur = res.processor.output_status();
                receipt
            });
            res.queue.submit(std::iter::once(encoder.finish()));
            let ticket = ReadbackTicket::new(receipt);
            let status_cb = ticket.status.clone();
            res.readbacks.as_ref().unwrap().2[idx]
                .buffer
                .slice(..)
                .map_async(wgpu::MapMode::Read, move |result| {
                    status_cb.store(
                        if result.is_ok() {
                            WS_READBACK_READY_OK
                        } else {
                            WS_READBACK_READY_ERR
                        },
                        Ordering::Release,
                    );
                });
            res.readbacks.as_mut().unwrap().2[idx].state = WsReadbackState::InFlight(ticket);
            res.current_idx = 1 - idx;
        }

        Ok(blurred_out)
    }
}

fn try_drain_readback(
    readback: &mut WsReadback,
    width: u32,
    height: u32,
    bytes_per_row_aligned: u32,
    pool: &mut Vec<Arc<Vec<u8>>>,
) -> Result<Option<BlurredFrame>, String> {
    let WsReadbackState::InFlight(ticket) = &mut readback.state else {
        return Ok(None);
    };
    let receipt = match ticket.take_ready() {
        Ok(Some(receipt)) => receipt,
        Ok(None) => return Ok(None),
        Err(error) => {
            readback.buffer.unmap();
            readback.state = WsReadbackState::Idle;
            return Err(error);
        }
    };
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
    #[cfg(not(target_os = "linux"))]
    let _ = receipt;
    Ok(Some(BlurredFrame {
        data: out,
        #[cfg(target_os = "linux")]
        receipt,
    }))
}

fn init_headless_blur() -> Result<WsBlurResources, String> {
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
    .map_err(|error| format!("Camera blur adapter unavailable: {error}"))?;

    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("WS Blur Device"),
        required_features: wgpu::Features::empty(),
        required_limits:
            wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
        memory_hints: Default::default(),
        trace: wgpu::Trace::Off,
    }))
    .map_err(|error| format!("Camera blur device unavailable: {error}"))?;

    let mut processor =
        cap_camera_effects::BlurProcessor::new(&device, wgpu::TextureFormat::Rgba8Unorm)
            .map_err(|error| format!("Camera blur processor unavailable: {error}"))?;
    processor.set_inference_interval(WS_BLUR_INFERENCE_INTERVAL);

    tracing::info!("WebSocket camera blur processor initialized (headless)");

    Ok(WsBlurResources {
        device,
        queue,
        processor,
        source_texture: None,
        readbacks: None,
        current_idx: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_plane_rows_without_stride_padding() {
        let src = [0, 1, 2, 3, 90, 91, 4, 5, 6, 7, 92, 93, 8, 9, 10, 11, 94, 95];
        let mut dst = vec![99];

        pack_plane_rows(&mut dst, &src, 4, 3, 6);

        assert_eq!(dst, [99, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    }

    #[test]
    fn packs_contiguous_plane_as_one_slice() {
        let src = [0, 1, 2, 3, 4, 5, 6, 7];
        let mut dst = Vec::new();

        pack_plane_rows(&mut dst, &src, 4, 2, 4);

        assert_eq!(dst, src);
    }

    #[cfg(target_os = "linux")]
    fn receipt(generation: u64, captured: Instant) -> crate::linux_instant_camera::FrameReceipt {
        crate::linux_instant_camera::FrameReceipt {
            timestamp: cap_timestamp::Timestamp::Instant(captured),
            generation,
            processing: cap_recording::instant_recording::LinuxCameraProcessing {
                mirrored: false,
                blur: cap_recording::instant_recording::LinuxCameraBlur::Off,
            },
            dimensions: (2, 1),
            blur: None,
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn asynchronous_readback_keeps_its_original_capture_and_generation() {
        let first = Instant::now();
        let second = first + Duration::from_millis(10);
        let mut a = ReadbackTicket::new(Some(receipt(7, first)));
        let mut b = ReadbackTicket::new(Some(receipt(8, second)));
        let a_ready = a.status.clone();
        let b_ready = b.status.clone();
        let (release, delayed) = tokio::sync::oneshot::channel();
        let (ready, notified) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            b_ready.store(WS_READBACK_READY_OK, Ordering::Release);
            ready.send(()).unwrap();
            delayed.await.unwrap();
            a_ready.store(WS_READBACK_READY_OK, Ordering::Release);
        });
        notified.await.unwrap();
        assert!(a.take_ready().unwrap().is_none());
        let newer = b.take_ready().unwrap().unwrap().unwrap();
        assert_eq!(newer.generation, 8);
        assert!(matches!(newer.timestamp,cap_timestamp::Timestamp::Instant(at) if at==second));
        assert!(b.take_ready().unwrap().is_none());
        release.send(()).unwrap();
        worker.await.unwrap();
        let older = a.take_ready().unwrap().unwrap().unwrap();
        assert_eq!(older.generation, 7);
        assert!(matches!(older.timestamp,cap_timestamp::Timestamp::Instant(at) if at==first));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn cancelled_readback_callback_cannot_certify_a_new_lease() {
        let old = ReadbackTicket::new(Some(receipt(1, Instant::now())));
        let callback = old.status.clone();
        drop(old);
        let mut fresh = ReadbackTicket::new(Some(receipt(2, Instant::now())));
        tokio::spawn(async move {
            callback.store(WS_READBACK_READY_OK, Ordering::Release);
        })
        .await
        .unwrap();
        assert!(fresh.take_ready().unwrap().is_none());
        fresh.status.store(WS_READBACK_READY_ERR, Ordering::Release);
        assert!(fresh.take_ready().is_err());
        assert!(fresh.take_ready().unwrap().is_none());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn hidden_websocket_does_not_disable_recording_demand_or_command_delivery() {
        let (frame_tx, frames) = flume::bounded::<u32>(2);
        let (command_tx, commands) = flume::bounded::<u32>(1);
        let frame_input = frames.clone();
        let command_input = commands.clone();
        let waiting = tokio::task::spawn_blocking(move || {
            next_worker_event(&frame_input, &command_input, None)
        });
        command_tx.send_async(7).await.unwrap();
        assert!(matches!(waiting.await.unwrap(), WorkerEvent::Command(7)));
        assert!(processing_needed(false, true));
        frame_tx.send_async(42).await.unwrap();
        assert!(matches!(
            next_worker_event(&frames, &commands, Some(Duration::from_secs(1))),
            WorkerEvent::Frame(42)
        ));
        assert!(!processing_needed(false, false));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn active_worker_polls_cancellation_without_needing_a_camera_frame() {
        let (_frame_tx, frames) = flume::bounded::<u32>(2);
        let (_command_tx, commands) = flume::bounded::<u32>(1);
        let waiting = tokio::task::spawn_blocking(move || {
            next_worker_event(&frames, &commands, Some(Duration::from_millis(1)))
        });
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), waiting)
                .await
                .unwrap()
                .unwrap(),
            WorkerEvent::Tick
        ));
    }
}
