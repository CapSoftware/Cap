//! Live background blur for the camera preview bubble -- the gpui counterpart
//! of the Tauri preview's blur path (`src-tauri/src/camera.rs:1328-1546`).
//!
//! The Tauri native preview renders every frame through its own wgpu device:
//! the camera IOSurface is imported as a texture, `cap_camera_effects::
//! BlurProcessor` segments + blurs it, and the output lands in the preview
//! surface. This app paints CVPixelBuffers directly (`paint_surface_fitted`),
//! so the same pipeline is bent into surface-in / surface-out form:
//!
//! 1. [`crate::camera_window`]'s `FrameConverter` hands over the converted
//!    BGRA IOSurface pixel buffer (already downscaled to [`BLUR_MAX_DIMS`] and
//!    mirrored when the toolbar says so).
//! 2. The buffer's IOSurface is imported as a `Bgra8Unorm` wgpu texture
//!    through `cap-rendering`'s `iosurface_texture` seam -- the exact import
//!    the Tauri `NativeFrameConverter` uses (`camera_native.rs:301-310`).
//!    Imports are cached per ring slot (keyed by pixel-buffer pointer +
//!    ring generation), so the steady state creates no textures.
//! 3. `BlurProcessor::process_into_encoder` runs the segmentation mask +
//!    separable blur + composite, with the preview's 150ms inference interval
//!    (`CAMERA_PREVIEW_BLUR_INFERENCE_INTERVAL`, `camera.rs:50`).
//! 4. `cap_rendering::RgbaToBgraSurfaceConverter` blits the RGBA output into
//!    a BGRA IOSurface-backed CVPixelBuffer from its own ring, and
//!    `PendingSurface::wait` blocks until the GPU has finished writing it, so
//!    the buffer handed back to the window is always complete when painted.
//!
//! Everything runs on one dedicated `camera-blur` thread (the Tauri preview
//! renders on a dedicated thread too, `camera.rs:466-490`), so the ~10ms
//! CoreML/CPU segmentation inference every 150ms never blocks the UI thread.
//! The channel back to the window is how "what you see is what records" holds:
//! this is the same `BlurProcessor` the editor/export camera layer runs
//! (`cap-rendering/src/lib.rs:5742`), fed by the same `BackgroundBlurMode`
//! the recording bridge writes into `project-config.json`.
//!
//! Failure degrades exactly like Tauri's `ensure_blur_processor`
//! (`camera.rs:1486-1519`): if the device, the ONNX runtime or the model
//! cannot be brought up, the worker exits, the window notices the closed
//! channel and keeps painting raw frames -- the toggle still cycles and
//! persists, nothing crashes.

#![cfg(target_os = "macos")]

use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context as _, anyhow};
use cap_rendering::{
    RgbaToBgraSurfaceConverter,
    iosurface_texture::{IOSurfaceTextureCache, import_metal_texture_to_wgpu},
};
use cidre::{arc, cv};

/// `CAMERA_PREVIEW_BLUR_MAX_TEXTURE_WIDTH/HEIGHT` (`camera.rs:46-47`): with
/// blur on, the Tauri preview processes at most 640x360 -- the blur passes
/// and the 256x256 segmentation downsample get a bounded input no matter what
/// the camera delivers. The `FrameConverter` applies this cap during its
/// hardware conversion, so the scale costs nothing extra.
pub const BLUR_MAX_DIMS: (usize, usize) = (640, 360);

/// `CAMERA_PREVIEW_BLUR_INFERENCE_INTERVAL` (`camera.rs:50`).
const BLUR_INFERENCE_INTERVAL: Duration = Duration::from_millis(150);

/// `LOW_SPEC_PREVIEW_RAM_THRESHOLD_BYTES` (`camera.rs:66`): machines at or
/// under 8GB never spin up the ONNX/wgpu blur processor -- the heaviest cost
/// in the preview. The toggle still cycles and persists; it just takes no
/// visual effect, exactly like `ensure_blur_processor`'s low-spec early
/// return (`camera.rs:1491-1498`).
const LOW_SPEC_RAM_THRESHOLD_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// The Tauri check reads total RAM once at startup (`init_preview_profile`,
/// `camera.rs:75-87`, via sysinfo); `hw.memsize` is the same number without
/// the dependency.
pub fn is_low_spec_preview() -> bool {
    static LOW_SPEC: OnceLock<bool> = OnceLock::new();
    *LOW_SPEC.get_or_init(|| {
        let mut bytes: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        let result = unsafe {
            libc::sysctlbyname(
                c"hw.memsize".as_ptr(),
                &mut bytes as *mut u64 as *mut libc::c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        let low_spec = result == 0 && bytes > 0 && bytes <= LOW_SPEC_RAM_THRESHOLD_BYTES;
        if low_spec {
            tracing::info!(
                total_ram_mb = bytes / 1_048_576,
                "low-spec camera preview profile: background blur preview disabled"
            );
        }
        low_spec
    })
}

/// A CVPixelBuffer crossing the worker boundary. CF objects have atomic
/// refcounts; same contract as `FrameConverter` and cap-rendering's
/// `SurfaceFrame`.
pub struct SendPixelBuf(pub arc::R<cv::PixelBuf>);
unsafe impl Send for SendPixelBuf {}

pub struct BlurJob {
    /// Converted BGRA IOSurface pixel buffer from the window's ring.
    pub buffer: SendPixelBuf,
    pub width: u32,
    pub height: u32,
    /// The `FrameConverter` ring generation the buffer belongs to; a rebuilt
    /// ring invalidates the worker's imported-texture cache so a recycled
    /// allocation address cannot alias a stale import.
    pub ring_generation: u64,
    pub mode: cap_camera_effects::BlurMode,
}

pub struct BlurOutput {
    /// Blurred BGRA IOSurface pixel buffer, GPU work complete.
    pub buffer: SendPixelBuf,
    pub width: u32,
    pub height: u32,
}

/// The worker loop. Runs until the job sender is dropped (blur switched off,
/// window closed) or an unrecoverable error; either way every GPU/ONNX
/// resource is dropped on exit, the same release-on-off behaviour as
/// `release_blur_resources` (`camera.rs:1477-1484`).
pub fn run(jobs: flume::Receiver<BlurJob>, results: flume::Sender<BlurOutput>) {
    // Current-thread runtime for `request_adapter` and the tokio yields
    // inside `PendingSurface::wait`.
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::warn!("camera blur worker runtime failed: {error}");
            return;
        }
    };

    let Some((device, queue)) = shared_device(&runtime) else {
        return;
    };

    let mut worker = match Worker::new(device, queue) {
        Ok(worker) => worker,
        Err(error) => {
            tracing::warn!("camera blur preview unavailable: {error:#}");
            return;
        }
    };

    while let Ok(mut job) = jobs.recv() {
        // Latest-wins, like the Tauri render loop draining `camera_rx`
        // (`camera.rs:1018-1020`).
        while let Ok(newer) = jobs.try_recv() {
            job = newer;
        }
        match worker.process(&runtime, job) {
            Ok(output) => {
                if results.send(output).is_err() {
                    return;
                }
            }
            Err(error) => {
                tracing::warn!("camera blur preview stopped: {error:#}");
                return;
            }
        }
    }
}

/// One device + queue for the app's blur lifetime, latched like Tauri's
/// `blur_processor_init_attempted`: a failed bring-up is not retried on every
/// toggle. The Tauri preview keeps its device for the window's lifetime
/// (`camera.rs:573-583`, `LowPower`, downlevel limits); only the ONNX/blur
/// resources are per-enable.
fn shared_device(runtime: &tokio::runtime::Runtime) -> Option<(wgpu::Device, wgpu::Queue)> {
    static DEVICE: OnceLock<Option<(wgpu::Device, wgpu::Queue)>> = OnceLock::new();
    DEVICE
        .get_or_init(|| {
            runtime.block_on(async {
                let instance = cap_rendering::create_wgpu_instance_sync();
                let adapter = instance
                    .request_adapter(&wgpu::RequestAdapterOptions {
                        power_preference: wgpu::PowerPreference::LowPower,
                        force_fallback_adapter: cap_rendering::force_software_wgpu_adapter(),
                        compatible_surface: None,
                    })
                    .await
                    .map_err(|error| {
                        tracing::warn!("camera blur adapter unavailable: {error}");
                    })
                    .ok()?;
                let (device, queue) = adapter
                    .request_device(&wgpu::DeviceDescriptor {
                        label: Some("Camera Preview Blur"),
                        required_features: wgpu::Features::empty(),
                        required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                            .using_resolution(adapter.limits()),
                        memory_hints: Default::default(),
                        trace: wgpu::Trace::Off,
                    })
                    .await
                    .map_err(|error| {
                        tracing::warn!("camera blur device unavailable: {error}");
                    })
                    .ok()?;
                Some((device, queue))
            })
        })
        .clone()
}

struct Worker {
    device: wgpu::Device,
    queue: wgpu::Queue,
    cache: IOSurfaceTextureCache,
    processor: cap_camera_effects::BlurProcessor,
    converter: RgbaToBgraSurfaceConverter,
    /// Imported input textures keyed by pixel-buffer pointer. The converter
    /// ring is four fixed buffers, so four entries cover the steady state and
    /// nothing is created per frame (stricter than the Tauri path, which
    /// re-imports each frame, `camera_native.rs:301-310`).
    imported: Vec<(usize, wgpu::Texture)>,
    imported_generation: u64,
    frame_number: u32,
}

impl Worker {
    fn new(device: wgpu::Device, queue: wgpu::Queue) -> anyhow::Result<Self> {
        let mut processor =
            cap_camera_effects::BlurProcessor::new(&device, wgpu::TextureFormat::Rgba8Unorm)
                .context("blur processor init")?;
        processor.set_inference_interval(BLUR_INFERENCE_INTERVAL);
        let converter =
            RgbaToBgraSurfaceConverter::new(&device).map_err(|error| anyhow!("{error}"))?;
        let cache = IOSurfaceTextureCache::new().context("Metal device unavailable")?;
        tracing::info!("camera blur preview initialized");
        Ok(Self {
            device,
            queue,
            cache,
            processor,
            converter,
            imported: Vec::new(),
            imported_generation: 0,
            frame_number: 0,
        })
    }

    fn process(
        &mut self,
        runtime: &tokio::runtime::Runtime,
        job: BlurJob,
    ) -> anyhow::Result<BlurOutput> {
        let mode = job.mode;
        let (width, height) = (job.width, job.height);
        let texture = self.input_texture(&job)?.clone();

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Camera Preview Blur"),
            });
        self.processor.process_into_encoder(
            &self.device,
            &self.queue,
            &texture,
            &mut encoder,
            mode,
        );
        let output = self
            .processor
            .process_returning_output()
            .context("blur output missing")?;

        self.frame_number = self.frame_number.wrapping_add(1);
        let pending = runtime
            .block_on(self.converter.encode(
                &self.device,
                &mut encoder,
                output,
                width,
                height,
                self.frame_number,
                30,
            ))
            .map_err(|error| anyhow!("{error}"))?;
        self.queue.submit(std::iter::once(encoder.finish()));

        let frame = runtime
            .block_on(pending.wait(&self.device, &self.queue))
            .map_err(|error| anyhow!("{error}"))?;
        Ok(BlurOutput {
            buffer: SendPixelBuf(frame.pixel_buffer),
            width: frame.width,
            height: frame.height,
        })
    }

    fn input_texture(&mut self, job: &BlurJob) -> anyhow::Result<&wgpu::Texture> {
        if self.imported_generation != job.ring_generation {
            self.imported.clear();
            self.imported_generation = job.ring_generation;
        }
        let key = &*job.buffer.0 as *const cv::PixelBuf as usize;
        if let Some(index) = self.imported.iter().position(|(k, _)| *k == key) {
            return Ok(&self.imported[index].1);
        }
        let io_surface = job
            .buffer
            .0
            .io_surf()
            .context("pixel buffer has no IOSurface")?;
        // A `Bgra8Unorm` binding samples as RGBA-ordered floats, so the blur
        // pipelines (all `Float { filterable: true }` layouts) and the 256px
        // segmentation downsample read correct channels with no extra
        // conversion pass.
        let metal = self
            .cache
            .create_bgra_texture(io_surface, job.width, job.height)
            .map_err(|error| anyhow!("{error}"))?;
        let texture = import_metal_texture_to_wgpu(
            &self.device,
            &metal,
            wgpu::TextureFormat::Bgra8Unorm,
            job.width,
            job.height,
            Some("Camera Blur Input"),
        )
        .map_err(|error| anyhow!("{error}"))?;
        self.imported.push((key, texture));
        Ok(&self.imported.last().expect("just pushed").1)
    }
}
