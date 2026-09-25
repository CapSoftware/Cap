use crate::project::LoadedProject;
use anyhow::{Context, Result, anyhow, bail};
use cap_project::XY;
use cap_rendering::{
    FrameWindows, GpuOutputFormat, Nv12RenderStartupBreakdownMs, Nv12RenderedFrame, RenderSegment,
    RenderVideoConstants, SharedWgpuDevice,
};
use ffmpeg::{
    Dictionary, Rational,
    codec::{self, flag::Flags},
    color,
    format::Pixel,
    frame,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{BufWriter, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};

/// The wgpu device outlives requests: the engine is one long-lived process per
/// slot, and creating an instance/adapter/device costs ~150-450 ms per chunk
/// (more when a GPU's slots all start at once). `RF_REUSE_DEVICE=0` disables.
type CachedDevice = (
    wgpu::Instance,
    wgpu::Adapter,
    wgpu::Device,
    wgpu::Queue,
    bool,
);
static DEVICE: Mutex<Option<CachedDevice>> = Mutex::new(None);

/// A slot renders several chunks of the same job back to back; the project
/// (config prep + probing every source file) is identical for all of them.
/// Job directories are unique, so the path is a safe key.
static PROJECT: Mutex<Option<Arc<LoadedProject>>> = Mutex::new(None);

fn load_project(path: &std::path::Path) -> Result<Arc<LoadedProject>> {
    if let Ok(cached) = PROJECT.lock()
        && let Some(project) = cached.as_ref().filter(|project| project.path == path)
    {
        return Ok(project.clone());
    }
    let project = Arc::new(LoadedProject::load(path)?);
    if let Ok(mut cached) = PROJECT.lock() {
        *cached = Some(project.clone());
    }
    Ok(project)
}

/// The process-wide device, created on first use.
async fn shared_device() -> Result<SharedWgpuDevice> {
    if let Some((instance, adapter, device, queue, is_software_adapter)) =
        DEVICE.lock().ok().and_then(|device| device.clone())
    {
        return Ok(SharedWgpuDevice {
            instance,
            adapter,
            device,
            queue,
            is_software_adapter,
        });
    }
    let shared = cap_rendering::create_shared_device()
        .await
        .map_err(|error| anyhow!("device: {error}"))?;
    if let Ok(mut device) = DEVICE.lock() {
        *device = Some((
            shared.instance.clone(),
            shared.adapter.clone(),
            shared.device.clone(),
            shared.queue.clone(),
            shared.is_software_adapter,
        ));
    }
    Ok(shared)
}

/// Off the next task's critical path: a fresh layer set (no project state)
/// for whichever project this slot renders next.
fn prebuild_spare_layers_in_background() {
    if !reuse_device() {
        return;
    }
    let Some((_, _, device, queue, is_software_adapter)) =
        DEVICE.lock().ok().and_then(|device| device.clone())
    else {
        return;
    };
    std::thread::spawn(move || {
        cap_rendering::prebuild_spare_layers(&device, &queue, is_software_adapter);
    });
}

/// Boot-time warmup: CUDA context, wgpu device and one spare layer set, so
/// the first task after a (re)start pays none of it.
pub async fn warm() -> Result<serde_json::Value> {
    let started = Instant::now();
    #[cfg(target_os = "linux")]
    if cap_rendering::linux_gpu::enabled() {
        cap_rendering::linux_gpu::init().map_err(|error| anyhow!("cuda: {error}"))?;
    }
    let shared = shared_device().await?;
    let device_ms = started.elapsed().as_millis() as u64;
    cap_rendering::prebuild_spare_layers(&shared.device, &shared.queue, shared.is_software_adapter);
    Ok(serde_json::json!({
        "device_ms": device_ms,
        "total_ms": started.elapsed().as_millis() as u64,
    }))
}

fn cap_rendering_gpu_frames_expected() -> bool {
    #[cfg(target_os = "linux")]
    {
        cap_rendering::linux_gpu::enabled()
            && std::env::var("RF_ENCODER").as_deref() == Ok("h264_nvenc")
    }
    #[cfg(not(target_os = "linux"))]
    false
}

fn reuse_device() -> bool {
    std::env::var("RF_REUSE_DEVICE").map_or(true, |value| value != "0")
}

#[derive(Deserialize)]
pub struct VideoRequest {
    pub project: PathBuf,
    pub fps: u32,
    pub resolution: [u32; 2],
    pub bpp: f32,
    pub frames: [u32; 2],
    pub threads: Option<usize>,
    pub out: PathBuf,
}

#[derive(Serialize)]
pub struct VideoResult {
    pub width: u32,
    pub height: u32,
    pub frames: u32,
    /// Length-prefixed (4 byte) H.264 samples, in decode order == display
    /// order because B-frames are off, exactly like the native export.
    pub sizes: Vec<u32>,
    pub keyframes: Vec<u32>,
    /// Annex B SPS/PPS from libx264's global header.
    pub extradata: String,
    pub bytes: u64,
    pub timings: VideoTimings,
}

#[derive(Serialize, Default)]
pub struct VideoTimings {
    pub load_ms: u64,
    pub constants_ms: u64,
    pub decoders_ms: u64,
    pub first_frame_ms: u64,
    pub render_ms: u64,
    pub total_ms: u64,
    pub startup: Option<Nv12RenderStartupBreakdownMs>,
    /// [allocated shared buffers, pooled, CUDA free MiB] at start and end.
    pub gpu_mem: Vec<[u64; 3]>,
    /// Cumulative ms per pipeline stage (render loop, forward hop, encoder).
    pub pipeline: Option<serde_json::Value>,
    /// Which parts ran on the GPU (adapter, decoders, CUDA frames to NVENC).
    pub gpu_path: Option<serde_json::Value>,
}

fn gpu_mem() -> [u64; 3] {
    #[cfg(target_os = "linux")]
    {
        let (allocated, pooled, free) = cap_rendering::linux_gpu::memory_stats();
        [allocated as u64, pooled as u64, free]
    }
    #[cfg(not(target_os = "linux"))]
    [0, 0, 0]
}

/// Same bitrate model as `cap_enc_ffmpeg::h264::get_bitrate`, so a chunked
/// export spends exactly the bits a desktop export would.
fn bitrate(width: u32, height: u32, fps: f32, bpp: f32) -> usize {
    let frame_rate_multiplier = ((fps as f64 - 30.0).max(0.0) * 0.6) + 30.0;
    (width as f64 * height as f64 * frame_rate_multiplier * bpp as f64) as usize
}

pub async fn render(request: VideoRequest) -> Result<VideoResult> {
    let started = Instant::now();
    #[cfg(target_os = "linux")]
    if cap_rendering::linux_gpu::enabled() {
        cap_rendering::linux_gpu::init().map_err(|error| anyhow!("cuda: {error}"))?;
    }
    let mut timings = VideoTimings::default();
    timings.gpu_mem.push(gpu_mem());
    let project = load_project(&request.project)?;
    let total_frames = project.total_frames(request.fps);
    if request.frames[0] >= request.frames[1] || request.frames[1] > total_frames {
        bail!("frame range {:?} outside 0..{total_frames}", request.frames);
    }
    let (width, height) = project.output_size(request.resolution)?;
    timings.load_ms = started.elapsed().as_millis() as u64;

    let phase = Instant::now();
    let constants = if reuse_device() {
        RenderVideoConstants::new_with_device(
            shared_device().await?,
            &project.recordings.segments,
            project.recording_meta.clone(),
            project.studio_meta.clone(),
        )
        .map_err(|error| anyhow!("renderer: {error}"))?
    } else {
        RenderVideoConstants::new(
            &project.recordings.segments,
            project.recording_meta.clone(),
            project.studio_meta.clone(),
        )
        .await
        .map_err(|error| anyhow!("renderer: {error}"))?
    };
    timings.constants_ms = phase.elapsed().as_millis() as u64;

    let phase = Instant::now();
    let segments = cap_editor::create_segments_without_audio(
        &project.recording_meta,
        &project.studio_meta,
        false,
    )
    .await
    .map_err(|error| anyhow!("decoders: {error}"))?;
    timings.decoders_ms = phase.elapsed().as_millis() as u64;

    // A render that silently fell off the GPU (llvmpipe, software decode)
    // still produces correct frames, just several times slower, and would
    // set the whole export's finish. With RF_REQUIRE_GPU=1 the chunk fails
    // fast instead, so the orchestrator retries it on a healthy engine.
    let screen_hw = segments.iter().all(|segment| {
        segment
            .decoders
            .screen_decoder_status()
            .decoder_type
            .is_hardware_accelerated()
    });
    let camera_hw = segments.iter().all(|segment| {
        segment
            .decoders
            .camera_decoder_status()
            .is_none_or(|status| status.decoder_type.is_hardware_accelerated())
    });
    timings.gpu_path = Some(serde_json::json!({
        "software_adapter": constants.is_software_adapter,
        "screen_hw_decode": screen_hw,
        "camera_hw_decode": camera_hw,
    }));
    if std::env::var("RF_REQUIRE_GPU").as_deref() == Ok("1")
        && (constants.is_software_adapter || !screen_hw || !camera_hw)
    {
        bail!(
            "gpu path degraded: software_adapter={} screen_hw_decode={screen_hw} camera_hw_decode={camera_hw}",
            constants.is_software_adapter
        );
    }

    let render_segments = segments
        .iter()
        .map(|segment| RenderSegment {
            cursor: segment.cursor.clone(),
            keyboard: segment.keyboard.clone(),
            decoders: segment.decoders.clone(),
            render_display: true,
        })
        .collect::<Vec<_>>();

    let expected = request.frames[1] - request.frames[0];
    let (frame_tx, frame_rx) = tokio::sync::mpsc::channel::<(Nv12RenderedFrame, u32)>(6);
    let (encode_tx, encode_rx) = std::sync::mpsc::sync_channel::<Nv12RenderedFrame>(6);
    let fps = request.fps;
    let bpp = request.bpp;
    let threads = request.threads;
    let out = request.out.clone();
    let encoder = std::thread::spawn(move || {
        encode(encode_rx, out, width, height, fps, bpp, threads, expected)
    });

    // Chunks of the same job on this slot share compiled layer pipelines.
    cap_rendering::set_layers_reuse_key(
        (std::env::var("RF_REUSE_LAYERS").map_or(true, |value| value != "0"))
            .then(|| format!("{}@{width}x{height}", request.project.display())),
    );
    let startup = Arc::new(Mutex::new(None));
    let render_started = Instant::now();
    let windows =
        FrameWindows::new(std::iter::once(request.frames[0]..request.frames[1]).collect());
    let render = cap_rendering::render_video_to_channel_nv12(
        &constants,
        &project.config,
        frame_tx,
        &project.recording_meta,
        &project.studio_meta,
        render_segments,
        request.fps,
        XY::new(request.resolution[0], request.resolution[1]),
        &project.recordings,
        Some(windows),
        None,
        Some(startup.clone()),
    );
    let forward = async {
        // Owning the receiver here means an encoder failure drops it, which
        // makes the renderer's next send fail instead of blocking forever.
        let mut frame_rx = frame_rx;
        let mut received = 0u32;
        let mut forward_blocked_us = 0u64;
        while let Some((frame, _)) = frame_rx.recv().await {
            if received == 0 {
                timings.first_frame_ms = render_started.elapsed().as_millis() as u64;
            }
            received += 1;
            if received % 15 == 0 {
                crate::report_progress(received);
            }
            let blocked = Instant::now();
            if encode_tx.send(frame).is_err() {
                break;
            }
            forward_blocked_us += blocked.elapsed().as_micros() as u64;
        }
        drop(encode_tx);
        (received, forward_blocked_us)
    };
    cap_rendering::loop_stats::take();
    let (render_result, (received, forward_blocked_us)) = tokio::join!(render, forward);
    let [decode, render_us, next_decode, join, send, _] = cap_rendering::loop_stats::take();
    render_result.map_err(|error| anyhow!("render: {error}"))?;
    timings.render_ms = render_started.elapsed().as_millis() as u64;

    let encoded = encoder
        .join()
        .map_err(|_| anyhow!("encoder thread panicked"))??;
    if received != expected || encoded.sizes.len() as u32 != expected {
        bail!(
            "chunk {:?} produced {received} rendered / {} encoded frames, expected {expected}",
            request.frames,
            encoded.sizes.len()
        );
    }
    timings.total_ms = started.elapsed().as_millis() as u64;
    timings.startup = startup.lock().ok().and_then(|slot| slot.clone());
    if let Some(serde_json::Value::Object(path)) = timings.gpu_path.as_mut() {
        path.insert("cuda_frames".into(), serde_json::json!(encoded.cuda_input));
    }
    if std::env::var("RF_REQUIRE_GPU").as_deref() == Ok("1")
        && cap_rendering_gpu_frames_expected()
        && !encoded.cuda_input
    {
        bail!("gpu path degraded: frames reached the encoder through system memory");
    }
    let ms = |us: u64| us / 1000;
    timings.pipeline = Some(serde_json::json!({
        "decode_wait": ms(decode),
        "render": ms(render_us),
        "next_decode": ms(next_decode),
        "render_join": ms(join),
        "send_wait": ms(send),
        "forward_blocked": ms(forward_blocked_us),
        "encoder_wait": ms(encoded.stats[0]),
        "cuda_copy": ms(encoded.stats[1]),
        "encode": ms(encoded.stats[2]),
    }));
    prebuild_spare_layers_in_background();
    timings.gpu_mem.push(gpu_mem());
    Ok(VideoResult {
        width,
        height,
        frames: expected,
        bytes: encoded.sizes.iter().map(|size| *size as u64).sum(),
        sizes: encoded.sizes,
        keyframes: encoded.keyframes,
        extradata: base64_encode(&encoded.extradata),
        timings,
    })
}

struct Encoded {
    sizes: Vec<u32>,
    keyframes: Vec<u32>,
    extradata: Vec<u8>,
    /// µs: waiting for the next frame, CUDA copy into the encoder surface,
    /// send_frame + packet drain.
    stats: [u64; 3],
    /// Frames reached NVENC as CUDA surfaces (no CPU round trip).
    cuda_input: bool,
}

#[allow(clippy::too_many_arguments)]
fn encode(
    frames: std::sync::mpsc::Receiver<Nv12RenderedFrame>,
    out: PathBuf,
    width: u32,
    height: u32,
    fps: u32,
    bpp: f32,
    threads: Option<usize>,
    expected: u32,
) -> Result<Encoded> {
    let encoder_name = std::env::var("RF_ENCODER").unwrap_or_else(|_| "libx264".to_string());
    let nvenc = encoder_name == "h264_nvenc";
    // The renderer decides where frames live; the first one tells us whether
    // NVENC should take CUDA surfaces (GPU-only path) or system memory.
    let first = frames.recv().ok();
    #[cfg(target_os = "linux")]
    let cuda_input = nvenc && first.as_ref().is_some_and(|frame| frame.gpu.is_some());
    #[cfg(not(target_os = "linux"))]
    let cuda_input = false;
    let cuda_frames = if cuda_input {
        Some(CudaFrames::new(width, height)?)
    } else {
        None
    };
    let codec = ffmpeg::encoder::find_by_name(&encoder_name)
        .with_context(|| format!("{encoder_name} unavailable"))?;
    let mut context = codec::context::Context::new_with_codec(codec);
    let threads = threads.unwrap_or_else(|| {
        std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(4)
    });
    if !nvenc {
        context.set_threading(ffmpeg::threading::Config::count(threads));
    }
    let mut encoder = context.encoder().video()?;
    encoder.set_width(width);
    encoder.set_height(height);
    encoder.set_format(if cuda_input { Pixel::CUDA } else { Pixel::NV12 });
    if let Some(cuda_frames) = &cuda_frames {
        unsafe {
            (*encoder.as_mut_ptr()).hw_frames_ctx = ffmpeg::ffi::av_buffer_ref(cuda_frames.frames);
        }
    }
    encoder.set_time_base(Rational::new(1, fps as i32));
    encoder.set_frame_rate(Some(Rational::new(fps as i32, 1)));
    encoder.set_colorspace(color::Space::BT709);
    encoder.set_color_range(color::Range::MPEG);
    unsafe {
        (*encoder.as_mut_ptr()).color_primaries = ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_BT709;
        (*encoder.as_mut_ptr()).color_trc =
            ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
    }
    let target = bitrate(width, height, fps as f32, bpp);
    encoder.set_bit_rate(target);
    encoder.set_max_bit_rate(target * 3 / 2);
    encoder.set_flags(Flags::GLOBAL_HEADER);

    let keyint = (fps * cap_enc_ffmpeg_keyframe_secs()).to_string();
    let mut options = Dictionary::new();
    if nvenc {
        // The native export's NVENC set (crates/enc-ffmpeg h264.rs), minus
        // B-frames: chunk assembly writes a table without composition offsets.
        // Preset p1 instead of p5: 4K is NVENC-bound, and against a lossless
        // render p1 measured 0.4 dB below p5 at the same bitrate for ~50% more
        // throughput. RF_NVENC_* override the set.
        let env =
            |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.into());
        options.set("preset", &env("RF_NVENC_PRESET", "p1"));
        options.set("tune", &env("RF_NVENC_TUNE", "hq"));
        if env("RF_NVENC_TUNE", "hq") == "lossless" {
            // Reference renders for quality comparisons.
            options.set("rc", "constqp");
            options.set("qp", "0");
        } else {
            options.set("rc", "vbr");
        }
        options.set("spatial-aq", &env("RF_NVENC_SAQ", "1"));
        options.set("temporal-aq", &env("RF_NVENC_TAQ", "1"));
        options.set("bf", "0");
        options.set("g", &keyint);
        options.set("forced-idr", "1");
    } else {
        // The native export's libx264 option set (crates/enc-ffmpeg h264.rs,
        // `is_export` + default preset), so quality and GOP match desktop output.
        options.set("preset", "veryfast");
        options.set("threads", &threads.to_string());
        options.set("bf", "0");
        options.set("rc-lookahead", "10");
        options.set("b-adapt", "0");
        options.set("aq-mode", "1");
        options.set("ref", "2");
        options.set("subme", "2");
        options.set("trellis", "0");
        options.set("g", &keyint);
        options.set("keyint_min", &keyint);
    }
    let mut encoder = encoder.open_as_with(codec, options)?;

    let extradata = unsafe {
        let pointer = encoder.as_ptr();
        std::slice::from_raw_parts((*pointer).extradata, (*pointer).extradata_size as usize)
            .to_vec()
    };

    crate::report_event("extradata", serde_json::json!(base64_encode(&extradata)));

    let mut output = BufWriter::with_capacity(8 << 20, File::create(&out)?);
    let mut sizes = Vec::with_capacity(expected as usize);
    let mut keyframes = Vec::new();
    let mut packet = ffmpeg::Packet::empty();
    // Frames before this index have been announced as finished GOPs.
    let mut announced = 0usize;
    let mut drain = |encoder: &mut ffmpeg::encoder::Video,
                     sizes: &mut Vec<u32>,
                     keyframes: &mut Vec<u32>|
     -> Result<()> {
        while encoder.receive_packet(&mut packet).is_ok() {
            let data = packet.data().ok_or_else(|| anyhow!("empty packet"))?;
            if packet.is_key() && sizes.len() > announced {
                // A new GOP starts: everything before it is final. Flush so
                // the worker can read those bytes and publish a segment now.
                output.flush()?;
                crate::report_event(
                    "gop",
                    serde_json::json!({ "first": announced, "sizes": &sizes[announced..] }),
                );
                announced = sizes.len();
            }
            let written = write_length_prefixed(&mut output, data)?;
            if packet.is_key() {
                keyframes.push(sizes.len() as u32);
            }
            sizes.push(written);
        }
        Ok(())
    };

    let mut nv12 = frame::Video::new(Pixel::NV12, width, height);
    let mut rgba_converter: Option<ffmpeg::software::scaling::Context> = None;
    let mut stats = [0u64; 3];
    let mut waiting = Instant::now();
    for (index, rendered) in first.into_iter().chain(frames.iter()).enumerate() {
        let pts = index as i64;
        stats[0] += waiting.elapsed().as_micros() as u64;
        #[cfg(target_os = "linux")]
        if let (Some(cuda_frames), Some(gpu)) = (&cuda_frames, rendered.gpu.as_ref()) {
            let copy = Instant::now();
            let mut surface = cuda_frames.frame(gpu, width, height)?;
            stats[1] += copy.elapsed().as_micros() as u64;
            surface.set_pts(Some(pts));
            drop(rendered);
            let encode = Instant::now();
            encoder.send_frame(&surface)?;
            drain(&mut encoder, &mut sizes, &mut keyframes)?;
            stats[2] += encode.elapsed().as_micros() as u64;
            waiting = Instant::now();
            continue;
        }
        if rendered.width != width || rendered.height != height {
            bail!(
                "renderer produced {}x{}, expected {width}x{height}",
                rendered.width,
                rendered.height
            );
        }
        // The encoder may still hold a reference to the previous frame's buffer.
        unsafe { ffmpeg::ffi::av_frame_make_writable(nv12.as_mut_ptr()) };
        if rendered.format == GpuOutputFormat::Rgba {
            let mut rgba = frame::Video::new(Pixel::RGBA, width, height);
            let stride = rgba.stride(0);
            let source_stride = rendered.y_stride as usize;
            for row in 0..height as usize {
                let length = (width as usize * 4).min(stride).min(source_stride);
                rgba.data_mut(0)[row * stride..row * stride + length].copy_from_slice(
                    &rendered.data[row * source_stride..row * source_stride + length],
                );
            }
            let converter = match &mut rgba_converter {
                Some(converter) => converter,
                None => rgba_converter.insert(ffmpeg::software::scaling::Context::get(
                    Pixel::RGBA,
                    width,
                    height,
                    Pixel::NV12,
                    width,
                    height,
                    ffmpeg::software::scaling::flag::Flags::BILINEAR,
                )?),
            };
            converter.run(&rgba, &mut nv12)?;
        } else {
            fill_nv12(&mut nv12, &rendered.data, width, height, rendered.y_stride);
        }
        nv12.set_pts(Some(pts));
        encoder.send_frame(&nv12)?;
        drain(&mut encoder, &mut sizes, &mut keyframes)?;
        waiting = Instant::now();
    }
    encoder.send_eof()?;
    drain(&mut encoder, &mut sizes, &mut keyframes)?;
    output.flush()?;
    if keyframes.first() != Some(&0) {
        bail!("chunk does not start with a keyframe");
    }
    Ok(Encoded {
        sizes,
        keyframes,
        extradata,
        stats,
        cuda_input,
    })
}

fn cap_enc_ffmpeg_keyframe_secs() -> u32 {
    2
}

fn fill_nv12(frame: &mut frame::Video, data: &[u8], width: u32, height: u32, y_stride: u32) {
    let width = width as usize;
    let height = height as usize;
    let y_stride = y_stride as usize;
    let destination_stride = frame.stride(0);
    for row in 0..height {
        frame.data_mut(0)[row * destination_stride..row * destination_stride + width]
            .copy_from_slice(&data[row * y_stride..row * y_stride + width]);
    }
    let uv = &data[y_stride * height..];
    let destination_stride = frame.stride(1);
    for row in 0..height / 2 {
        frame.data_mut(1)[row * destination_stride..row * destination_stride + width]
            .copy_from_slice(&uv[row * width..row * width + width]);
    }
}

/// libx264 emits Annex B; MP4 wants 4-byte NAL lengths. Returns bytes written.
fn write_length_prefixed(output: &mut impl Write, data: &[u8]) -> Result<u32> {
    let mut written = 0u32;
    let starts = nal_starts(data);
    for (index, &(start, prefix)) in starts.iter().enumerate() {
        let payload_start = start + prefix;
        let payload_end = starts
            .get(index + 1)
            .map(|&(next, _)| next)
            .unwrap_or(data.len());
        let mut end = payload_end;
        while end > payload_start && data[end - 1] == 0 {
            end -= 1;
        }
        let nal = &data[payload_start..end];
        if nal.is_empty() {
            continue;
        }
        output.write_all(&(nal.len() as u32).to_be_bytes())?;
        output.write_all(nal)?;
        written += 4 + nal.len() as u32;
    }
    Ok(written)
}

fn nal_starts(data: &[u8]) -> Vec<(usize, usize)> {
    let mut starts = Vec::new();
    let mut index = 0;
    while index + 3 <= data.len() {
        if data[index] == 0 && data[index + 1] == 0 {
            if data[index + 2] == 1 {
                starts.push((index, 3));
                index += 3;
                continue;
            }
            if index + 4 <= data.len() && data[index + 2] == 0 && data[index + 3] == 1 {
                starts.push((index, 4));
                index += 4;
                continue;
            }
        }
        index += 1;
    }
    starts
}

pub fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// NVENC input surfaces in CUDA memory (hw_frames_ctx), filled device-to-
/// device from the renderer's shared output buffers.
struct CudaFrames {
    device: *mut ffmpeg::ffi::AVBufferRef,
    frames: *mut ffmpeg::ffi::AVBufferRef,
}

impl CudaFrames {
    fn new(width: u32, height: u32) -> Result<Self> {
        use ffmpeg::ffi::*;
        unsafe {
            let mut device = std::ptr::null_mut();
            let mut options = std::ptr::null_mut();
            av_dict_set(&mut options, c"primary_ctx".as_ptr(), c"1".as_ptr(), 0);
            let created = av_hwdevice_ctx_create(
                &mut device,
                AVHWDeviceType::AV_HWDEVICE_TYPE_CUDA,
                std::ptr::null(),
                options,
                0,
            );
            av_dict_free(&mut options);
            if created < 0 {
                bail!("CUDA device for NVENC: {created}");
            }
            let frames = av_hwframe_ctx_alloc(device);
            if frames.is_null() {
                bail!("av_hwframe_ctx_alloc failed");
            }
            let context = (*frames).data as *mut AVHWFramesContext;
            (*context).format = AVPixelFormat::AV_PIX_FMT_CUDA;
            (*context).sw_format = AVPixelFormat::AV_PIX_FMT_NV12;
            (*context).width = width as i32;
            (*context).height = height as i32;
            (*context).initial_pool_size = 8;
            let initialised = av_hwframe_ctx_init(frames);
            if initialised < 0 {
                bail!("CUDA frame pool: {initialised}");
            }
            Ok(Self { device, frames })
        }
    }

    #[cfg(target_os = "linux")]
    fn frame(
        &self,
        gpu: &cap_rendering::linux_gpu::GpuNv12Output,
        width: u32,
        height: u32,
    ) -> Result<frame::Video> {
        let mut surface = frame::Video::empty();
        unsafe {
            let result = ffmpeg::ffi::av_hwframe_get_buffer(self.frames, surface.as_mut_ptr(), 0);
            if result < 0 {
                bail!("av_hwframe_get_buffer: {result}");
            }
            let raw = surface.as_mut_ptr();
            (*raw).color_range = ffmpeg::ffi::AVColorRange::AVCOL_RANGE_MPEG;
            (*raw).colorspace = ffmpeg::ffi::AVColorSpace::AVCOL_SPC_BT709;
            (*raw).color_primaries = ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_BT709;
            (*raw).color_trc = ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
            let source = gpu.cuda_ptr();
            cap_rendering::linux_gpu::copy_plane(
                source,
                gpu.y_stride as usize,
                (*raw).data[0] as u64,
                (*raw).linesize[0] as usize,
                width as usize,
                height as usize,
            )
            .map_err(|error| anyhow!(error))?;
            cap_rendering::linux_gpu::copy_plane(
                source + gpu.uv_offset,
                gpu.uv_stride as usize,
                (*raw).data[1] as u64,
                (*raw).linesize[1] as usize,
                width as usize,
                height as usize / 2,
            )
            .map_err(|error| anyhow!(error))?;
            // The source slot is released (and reused by Vulkan) once `gpu`
            // drops, so the copy must have landed before this returns.
            cap_rendering::linux_gpu::synchronize().map_err(|error| anyhow!(error))?;
        }
        Ok(surface)
    }
}

impl Drop for CudaFrames {
    fn drop(&mut self) {
        unsafe {
            ffmpeg::ffi::av_buffer_unref(&mut self.frames);
            ffmpeg::ffi::av_buffer_unref(&mut self.device);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annex_b_packets_become_length_prefixed_samples() {
        let packet = [
            0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x00, 0, 0, 0, 1, 0x06, 0x05,
        ];
        let mut out = Vec::new();
        let written = write_length_prefixed(&mut out, &packet).unwrap();
        assert_eq!(
            out,
            [
                0, 0, 0, 2, 0x09, 0xf0, 0, 0, 0, 3, 0x65, 0x88, 0x84, 0, 0, 0, 2, 0x06, 0x05
            ]
        );
        assert_eq!(written as usize, out.len());
    }

    #[test]
    fn packets_without_start_codes_write_nothing() {
        let mut out = Vec::new();
        assert_eq!(write_length_prefixed(&mut out, &[0x65, 0x88]).unwrap(), 0);
        assert!(out.is_empty());
    }

    #[test]
    fn finds_three_and_four_byte_start_codes() {
        let data = [0, 0, 1, 0x67, 0, 0, 0, 1, 0x68, 0xaa];
        assert_eq!(nal_starts(&data), vec![(0, 3), (4, 4)]);
    }

    #[test]
    fn bitrate_matches_the_native_export_model() {
        assert_eq!(bitrate(1920, 1080, 30.0, 0.3), 18_662_400);
        assert!(bitrate(1920, 1080, 60.0, 0.3) > bitrate(1920, 1080, 30.0, 0.3));
    }
}
