use anyhow::{Context, anyhow};
#[cfg(not(target_os = "macos"))]
use cap_recording::FFmpegVideoFrame;
#[cfg(target_os = "macos")]
use cap_recording::NativeCameraFrame;
use cap_recording::feeds::{self, camera::CameraFeed};
#[cfg(target_os = "macos")]
use cap_utils::macos_qos::{MacOsQosClass, set_current_thread_qos};

#[cfg(target_os = "macos")]
use crate::camera_native::{NativeFrameConverter, classify_frame};
use ffmpeg::{
    format::{self, Pixel},
    frame,
    software::scaling,
};
use kameo::actor::ActorRef;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    thread,
};
use tauri::{LogicalPosition, LogicalSize, PhysicalSize, WebviewWindow};
use tokio::{
    runtime::Runtime,
    sync::{broadcast, oneshot},
    task::LocalSet,
    time::{Duration, Instant},
};
use tracing::{error, info, trace, warn};
use wgpu::{CompositeAlphaMode, SurfaceTexture};

static TOOLBAR_HEIGHT: f32 = 56.0;

const DEFAULT_SURFACE_SCALE: f64 = 2.0;
// Quantizing the target texture width stops drag-resizing from rebuilding the
// scaler, preview texture, and bind group on every 1px size change.
const CAMERA_PREVIEW_TEXTURE_WIDTH_BUCKET: u32 = 64;
const CAMERA_PREVIEW_MIN_TEXTURE_WIDTH: u32 = 320;
const CAMERA_PREVIEW_MAX_TEXTURE_WIDTH: u32 = 960;
const CAMERA_PREVIEW_MAX_TEXTURE_HEIGHT: u32 = 540;
const CAMERA_PREVIEW_BLUR_MAX_TEXTURE_WIDTH: u32 = 640;
const CAMERA_PREVIEW_BLUR_MAX_TEXTURE_HEIGHT: u32 = 360;
const CAMERA_PREVIEW_TARGET_FRAME_INTERVAL: Duration = Duration::from_micros(16_666);
const CAMERA_PREVIEW_FRAME_INTERVAL_SLACK: Duration = Duration::from_millis(1);
const CAMERA_PREVIEW_BLUR_INFERENCE_INTERVAL: Duration = Duration::from_millis(150);

// ── Low-spec preview profile ────────────────────────────────────────────────
// On low-RAM machines (e.g. an 8GB iMac) the full-quality preview is laggy, so
// we opt those machines into a cheaper preview: smaller textures, 30fps pacing,
// and (most importantly) NO background-blur init at all. This is gated by a
// single startup RAM check (see `init_preview_profile`); on every machine with
// more than the threshold, `is_low_spec_preview()` returns `false` and the
// preview path uses the high-spec constants above bit-for-bit, so there is zero
// behavioural change for >8GB machines. This affects ONLY the preview — the
// recording pipeline is entirely separate and untouched.
const CAMERA_PREVIEW_LOW_SPEC_MAX_TEXTURE_WIDTH: u32 = 640;
const CAMERA_PREVIEW_LOW_SPEC_MAX_TEXTURE_HEIGHT: u32 = 360;
const CAMERA_PREVIEW_LOW_SPEC_TARGET_FRAME_INTERVAL: Duration = Duration::from_micros(33_333);

/// Machines with total RAM at or below this are treated as low-spec for preview.
pub const LOW_SPEC_PREVIEW_RAM_THRESHOLD_BYTES: u64 = 8 * 1024 * 1024 * 1024;

static LOW_SPEC_PREVIEW: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Detect the preview profile once at startup from the machine's total RAM and
/// log the result. Subsequent calls are no-ops (the first value wins), so this
/// is safe to call from a single startup site. Reading via
/// `is_low_spec_preview()` never touches sysinfo, so there are no per-frame
/// system queries.
pub fn init_preview_profile(total_ram_bytes: u64) -> bool {
    let low_spec = total_ram_bytes <= LOW_SPEC_PREVIEW_RAM_THRESHOLD_BYTES;
    // Only the first set takes effect; ignore the (impossible in practice)
    // racing second caller.
    let _ = LOW_SPEC_PREVIEW.set(low_spec);
    let active = *LOW_SPEC_PREVIEW.get().unwrap_or(&low_spec);
    info!(
        total_ram_mb = total_ram_bytes / 1_048_576,
        low_spec_preview = active,
        "Camera preview profile detected"
    );
    active
}

/// Whether the low-spec preview profile is active. Defaults to `false` (the
/// high-spec / current behaviour) if detection never ran, so any unexpected
/// ordering can only ever fall back to the existing >8GB behaviour.
#[inline]
pub fn is_low_spec_preview() -> bool {
    *LOW_SPEC_PREVIEW.get().unwrap_or(&false)
}

pub const MIN_CAMERA_SIZE: f32 = 150.0;
pub const MAX_CAMERA_SIZE: f32 = 600.0;
pub const DEFAULT_CAMERA_SIZE: f32 = 230.0;
pub const WIDE_CAMERA_ASPECT_RATIO: f32 = 16.0 / 9.0;

// On macOS the preview consumes retained CMSampleBuffers and renders them via
// a zero-copy IOSurface->Metal->wgpu import; everywhere else it consumes the
// CPU-converted ffmpeg frames.
#[cfg(target_os = "macos")]
type PreviewCameraFrame = NativeCameraFrame;
#[cfg(not(target_os = "macos"))]
type PreviewCameraFrame = FFmpegVideoFrame;

#[derive(Clone)]
pub enum CameraPreviewSender {
    #[cfg(not(target_os = "macos"))]
    Ffmpeg(flume::Sender<FFmpegVideoFrame>),
    #[cfg(target_os = "macos")]
    Native(flume::Sender<NativeCameraFrame>),
}

impl CameraPreviewSender {
    fn from_tx(tx: flume::Sender<PreviewCameraFrame>) -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::Native(tx)
        }
        #[cfg(not(target_os = "macos"))]
        {
            Self::Ffmpeg(tx)
        }
    }

    pub async fn attach(&self, feed: &ActorRef<CameraFeed>) -> Result<(), String> {
        match self {
            #[cfg(not(target_os = "macos"))]
            Self::Ffmpeg(tx) => feed
                .ask(feeds::camera::AddSender(tx.clone()))
                .await
                .map_err(|err| err.to_string()),
            #[cfg(target_os = "macos")]
            Self::Native(tx) => feed
                .ask(feeds::camera::AddNativeSender(tx.clone()))
                .await
                .map_err(|err| err.to_string()),
        }
    }

    pub async fn detach(&self, feed: &ActorRef<CameraFeed>) -> Result<(), String> {
        match self {
            #[cfg(not(target_os = "macos"))]
            Self::Ffmpeg(tx) => feed
                .ask(feeds::camera::RemoveSender(tx.clone()))
                .await
                .map_err(|err| err.to_string()),
            #[cfg(target_os = "macos")]
            Self::Native(tx) => feed
                .ask(feeds::camera::RemoveNativeSender(tx.clone()))
                .await
                .map_err(|err| err.to_string()),
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CameraPreviewShape {
    #[default]
    Round,
    Square,
    Full,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct CameraPreviewState {
    pub size: f32,
    pub shape: CameraPreviewShape,
    pub mirrored: bool,
    #[serde(default)]
    pub background_blur: cap_project::BackgroundBlurMode,
}

impl Default for CameraPreviewState {
    fn default() -> Self {
        Self {
            size: DEFAULT_CAMERA_SIZE,
            shape: CameraPreviewShape::default(),
            mirrored: false,
            background_blur: cap_project::BackgroundBlurMode::Off,
        }
    }
}

fn clamp_size(size: f32) -> f32 {
    size.clamp(MIN_CAMERA_SIZE, MAX_CAMERA_SIZE)
}

fn preferred_alpha_mode(alpha_modes: &[CompositeAlphaMode]) -> CompositeAlphaMode {
    [
        CompositeAlphaMode::PreMultiplied,
        CompositeAlphaMode::PostMultiplied,
        CompositeAlphaMode::Opaque,
        CompositeAlphaMode::Auto,
        CompositeAlphaMode::Inherit,
    ]
    .into_iter()
    .find(|mode| alpha_modes.contains(mode))
    .or_else(|| alpha_modes.first().copied())
    .unwrap_or(CompositeAlphaMode::Opaque)
}

fn camera_preview_frame_due(last_render_at: Option<Instant>, now: Instant) -> bool {
    // High-spec keeps the original 60fps target; low-spec paces at 30fps.
    let target_interval = if is_low_spec_preview() {
        CAMERA_PREVIEW_LOW_SPEC_TARGET_FRAME_INTERVAL
    } else {
        CAMERA_PREVIEW_TARGET_FRAME_INTERVAL
    };
    last_render_at.is_none_or(|last| {
        now.saturating_duration_since(last) + CAMERA_PREVIEW_FRAME_INTERVAL_SLACK >= target_interval
    })
}

fn camera_preview_texture_dimensions(
    source_width: u32,
    source_height: u32,
    region_width: u32,
    region_height: u32,
    blur_enabled: bool,
) -> (u32, u32) {
    let source_width = source_width.max(1);
    let source_height = source_height.max(1);
    let region_width = region_width.max(1);
    let region_height = region_height.max(1);
    let (max_width, max_height) = if is_low_spec_preview() {
        // Low-spec caps preview to 640x360 regardless of blur (blur is skipped
        // entirely on low-spec, so `blur_enabled` is effectively always false
        // here, but we clamp unconditionally to stay safe if that ever changes).
        (
            CAMERA_PREVIEW_LOW_SPEC_MAX_TEXTURE_WIDTH,
            CAMERA_PREVIEW_LOW_SPEC_MAX_TEXTURE_HEIGHT,
        )
    } else if blur_enabled {
        (
            CAMERA_PREVIEW_BLUR_MAX_TEXTURE_WIDTH,
            CAMERA_PREVIEW_BLUR_MAX_TEXTURE_HEIGHT,
        )
    } else {
        (
            CAMERA_PREVIEW_MAX_TEXTURE_WIDTH,
            CAMERA_PREVIEW_MAX_TEXTURE_HEIGHT,
        )
    };
    let source_aspect = source_width as f64 / source_height as f64;
    let cover_width = (region_width as f64).max(region_height as f64 * source_aspect);
    let requested_width = (cover_width.ceil() as u32)
        .max(CAMERA_PREVIEW_MIN_TEXTURE_WIDTH)
        .div_ceil(CAMERA_PREVIEW_TEXTURE_WIDTH_BUCKET)
        .saturating_mul(CAMERA_PREVIEW_TEXTURE_WIDTH_BUCKET)
        .min(max_width);
    let scale = (requested_width as f64 / source_width as f64)
        .min(max_height as f64 / source_height as f64)
        .min(1.0);
    let target_width = ((source_width as f64 * scale).round() as u32).max(1);
    let target_height = ((source_height as f64 * scale).round() as u32).max(1);
    (target_width, target_height)
}

pub struct CameraPreviewManager {
    store: Result<Arc<tauri_plugin_store::Store<tauri::Wry>>, String>,
    store_save_generation: Arc<AtomicU64>,
    preview: Option<InitializedCameraPreview>,
    preview_session_id: Arc<AtomicU64>,
    wgpu_instance: wgpu::Instance,
}

impl CameraPreviewManager {
    pub fn new(app: &tauri::AppHandle) -> Self {
        Self {
            store: tauri_plugin_store::StoreBuilder::new(app, "cameraPreview")
                .build()
                .map_err(|err| format!("Error initializing camera preview store: {err}")),
            store_save_generation: Arc::new(AtomicU64::new(0)),
            preview: None,
            preview_session_id: Arc::new(AtomicU64::new(0)),
            wgpu_instance: cap_rendering::create_wgpu_instance_sync(),
        }
    }

    pub fn session_id_handle(&self) -> Arc<AtomicU64> {
        self.preview_session_id.clone()
    }

    pub fn get_state(&self) -> anyhow::Result<CameraPreviewState> {
        let mut state: CameraPreviewState = self
            .store
            .as_ref()
            .map_err(|err| anyhow!("{err}"))?
            .get("state")
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();

        state.size = clamp_size(state.size);
        Ok(state)
    }

    pub fn set_state(&self, mut state: CameraPreviewState) -> anyhow::Result<()> {
        state.size = clamp_size(state.size);

        let store = self.store.as_ref().map_err(|err| anyhow!("{err}"))?;
        store.set("state", serde_json::to_value(&state)?);

        // set_state fires per mousemove during a size drag; debounce the disk
        // write so only the post-drag state is persisted.
        let generation = self.store_save_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let save_generation = self.store_save_generation.clone();
        let store = store.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            if save_generation.load(Ordering::Acquire) == generation
                && let Err(err) = store.save()
            {
                error!("Error saving camera preview store: {err}");
            }
        });

        if let Some(preview) = &self.preview {
            preview
                .reconfigure
                .send(ReconfigureEvent::State(state))
                .map_err(|err| error!("Error asking camera preview to reconfigure: {err}"))
                .ok();
        }

        Ok(())
    }

    pub fn is_initialized(&self) -> bool {
        self.preview.is_some()
    }

    pub fn is_paused(&self) -> bool {
        self.preview
            .as_ref()
            .is_some_and(|preview| preview.is_paused)
    }

    pub fn sender(&self) -> Option<CameraPreviewSender> {
        self.preview
            .as_ref()
            .map(|p| CameraPreviewSender::from_tx(p.camera_tx.clone()))
    }

    pub fn notify_window_resized(&self, width: u32, height: u32) {
        if let Some(preview) = &self.preview {
            preview
                .reconfigure
                .send(ReconfigureEvent::WindowResized { width, height })
                .map_err(|err| error!("Error notifying camera preview of resize: {err}"))
                .ok();
        }
    }

    // Pauses the camera preview, hiding the window but keeping GPU resources alive.
    // Called when the user deselects the camera. This is part of the persistent
    // renderer architecture that prevents crashes from repeated resource creation.
    pub fn pause(&mut self) {
        if let Some(preview) = &mut self.preview
            && !preview.is_paused
        {
            preview.is_paused = true;
            preview
                .reconfigure
                .send(ReconfigureEvent::Pause)
                .map_err(|err| error!("Error sending camera preview pause event: {err}"))
                .ok();
        }
    }

    pub fn begin_shutdown(&mut self) -> Option<oneshot::Receiver<()>> {
        let preview = self.preview.take()?;
        info!(
            "Camera preview shutdown requested (session {}).",
            preview.session_id
        );
        preview
            .reconfigure
            .send(ReconfigureEvent::Shutdown)
            .map_err(|err| error!("Error sending camera preview shutdown event: {err}"))
            .ok();
        Some(preview.shutdown_complete)
    }

    pub async fn init_window(
        &mut self,
        window: WebviewWindow,
        actor: ActorRef<CameraFeed>,
    ) -> anyhow::Result<()> {
        if let Some(preview) = &mut self.preview {
            CameraPreviewSender::from_tx(preview.camera_tx.clone())
                .attach(&actor)
                .await
                .map_err(|err| anyhow!("Error re-attaching camera feed consumer: {err}"))?;

            if preview.is_paused {
                preview.is_paused = false;
                preview
                    .reconfigure
                    .send(ReconfigureEvent::Resume)
                    .map_err(|err| error!("Error sending camera preview resume event: {err}"))
                    .ok();
            }

            window
                .run_on_main_thread({
                    let window = window.clone();
                    move || {
                        let _ = window.show();
                    }
                })
                .ok();

            return Ok(());
        }

        let session_id = self.preview_session_id.fetch_add(1, Ordering::AcqRel) + 1;

        let (camera_tx, camera_rx) = flume::bounded::<PreviewCameraFrame>(1);

        CameraPreviewSender::from_tx(camera_tx.clone())
            .attach(&actor)
            .await
            .map_err(|err| anyhow!("Error attaching camera feed consumer: {err}"))?;

        let default_state = self
            .get_state()
            .map_err(|err| error!("Error getting camera preview state: {err}"))
            .unwrap_or_default();

        // Capacity must absorb bursts of control events (State spam during a
        // size drag interleaved with Pause/Resume); a lagged capacity-1 channel
        // could drop a Resume and leave the preview stuck hidden.
        let (reconfigure, reconfigure_rx) = broadcast::channel(8);
        let mut renderer = InitializedCameraPreview::init_wgpu(
            window.clone(),
            &default_state,
            self.wgpu_instance.clone(),
        )
        .await?;
        window
            .run_on_main_thread({
                let window = window.clone();
                move || {
                    let _ = window.show();
                }
            })
            .ok();

        let rt = Runtime::new().context("Failed to create camera preview runtime")?;
        let (shutdown_complete_tx, shutdown_complete_rx) = oneshot::channel();

        self.preview = Some(InitializedCameraPreview {
            reconfigure,
            session_id,
            shutdown_complete: shutdown_complete_rx,
            camera_tx,
            is_paused: false,
        });

        thread::spawn(move || {
            #[cfg(target_os = "macos")]
            {
                let result = set_current_thread_qos(MacOsQosClass::UserInteractive);
                if result != 0 {
                    warn!(result, "pthread_set_qos_class_self_np failed");
                }
            }
            LocalSet::new().block_on(
                &rt,
                renderer.run(window.clone(), default_state, reconfigure_rx, camera_rx),
            );

            let (drop_tx, drop_rx) = oneshot::channel();
            let renderer = Box::new(renderer);
            let _ = window.run_on_main_thread(move || {
                drop(renderer);
                let _ = drop_tx.send(());
            });

            wait_for_shutdown_signal(&rt, drop_rx, Duration::from_millis(250));

            shutdown_complete_tx.send(()).ok();
            info!("DONE");
        });

        Ok(())
    }
}

fn wait_for_shutdown_signal(runtime: &Runtime, receiver: oneshot::Receiver<()>, timeout: Duration) {
    runtime.block_on(async move {
        let _ = tokio::time::timeout(timeout, receiver).await;
    });
}

// Internal events for the persistent camera renderer architecture.
//
// The camera preview uses a persistent WGPU renderer that stays alive across
// camera deselect/reselect cycles. This avoids repeated GPU resource creation
// which, combined with macOS panel.order_front_regardless() calls, was causing
// crashes after ~4-5 toggle cycles.
//
// Pause/Resume hide/show the window while keeping GPU resources alive.
// See the comment in windows.rs ShowCapWindow::Camera for the critical detail
// about avoiding order_front_regardless().
#[derive(Clone)]
enum ReconfigureEvent {
    State(CameraPreviewState),
    WindowResized { width: u32, height: u32 },
    Pause,
    Resume,
    Shutdown,
}

struct InitializedCameraPreview {
    reconfigure: broadcast::Sender<ReconfigureEvent>,
    session_id: u64,
    shutdown_complete: oneshot::Receiver<()>,
    camera_tx: flume::Sender<PreviewCameraFrame>,
    is_paused: bool,
}

impl InitializedCameraPreview {
    async fn init_wgpu(
        window: WebviewWindow,
        default_state: &CameraPreviewState,
        instance: wgpu::Instance,
    ) -> anyhow::Result<Renderer> {
        let aspect = if default_state.shape == CameraPreviewShape::Full {
            WIDE_CAMERA_ASPECT_RATIO
        } else {
            1.0
        };

        let (window_width, window_height, surface_scale) =
            resize_window(&window, default_state, aspect, false)
                .await
                .context("Error resizing Tauri window")?;

        let (tx, rx) = oneshot::channel();
        window
            .run_on_main_thread({
                let window = window.clone();
                let instance = instance.clone();
                move || {
                    let surface = instance.create_surface(window.clone());
                    tx.send(surface).ok();
                }
            })
            .with_context(|| "Failed to initialize wgpu instance")?;

        let surface = rx
            .await
            .with_context(|| "Failed to receive initialized wgpu surface")?;
        let surface = surface.with_context(|| "Failed to initialize wgpu surface")?;

        let force_software_adapter = cap_rendering::force_software_wgpu_adapter();
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::LowPower,
                force_fallback_adapter: force_software_adapter,
                compatible_surface: Some(&surface),
            })
            .await
            .with_context(|| "Failed to find an appropriate wgpu adapter")?;

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: None,
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                    .using_resolution(adapter.limits()),
                memory_hints: Default::default(),
                trace: wgpu::Trace::Off,
            })
            .await
            .with_context(|| "Failed to create wgpu device")?;

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: None,
            source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Borrowed(include_str!(
                "./camera.wgsl"
            ))),
        });

        let uniform_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Uniform Bind Group Layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Texture Bind Group Layout"),
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

        let state_uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("State Uniform Buffer"),
            size: std::mem::size_of::<StateUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let window_uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Window Uniform Buffer"),
            size: std::mem::size_of::<WindowUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let camera_uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Camera Uniform Buffer"),
            size: std::mem::size_of::<CameraUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Uniform Bind Group"),
            layout: &uniform_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: state_uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: window_uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: camera_uniform_buffer.as_entire_binding(),
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&bind_group_layout, &uniform_bind_group_layout],
            push_constant_ranges: &[],
        });

        let swapchain_format = wgpu::TextureFormat::Bgra8Unorm;
        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: None,
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
                    format: swapchain_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
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

        let surface_capabilities = surface.get_capabilities(&adapter);
        let alpha_mode = preferred_alpha_mode(&surface_capabilities.alpha_modes);

        let present_mode = if surface_capabilities
            .present_modes
            .contains(&wgpu::PresentMode::Mailbox)
        {
            wgpu::PresentMode::Mailbox
        } else {
            wgpu::PresentMode::Fifo
        };

        let surface_config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: swapchain_format,
            width: window_width,
            height: window_height,
            present_mode,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 1,
        };

        surface.configure(&device, &surface_config);

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let mut renderer = Renderer {
            surface: Some(surface),
            surface_config,
            surface_scale,
            render_pipeline,
            device,
            queue,
            sampler,
            bind_group_layout,
            state_uniform_buffer,
            window_uniform_buffer,
            camera_uniform_buffer,
            uniform_bind_group,
            texture: Cached::default(),
            aspect_ratio: Cached::default(),
            blur_processor: None,
            blur_processor_init_attempted: false,
            blur_source_texture: None,
            #[cfg(target_os = "macos")]
            native_converter: None,
            #[cfg(target_os = "macos")]
            native_converter_init_attempted: false,
        };

        renderer.update_state_uniforms(default_state);
        renderer
            .sync_ratio_uniform_and_resize_window_to_it(&window, default_state, aspect)
            .await;
        renderer.reconfigure_gpu_surface(window_width, window_height);

        let initial_surface = renderer.acquire_surface_texture();
        if let Some(surface) = initial_surface {
            let output_width = 5;
            let output_height = 5;

            let (buffer, stride) =
                render_solid_frame([0x11, 0x11, 0x11, 0xFF], output_width, output_height);

            PreparedTexture::init(
                renderer.device.clone(),
                renderer.queue.clone(),
                &renderer.sampler,
                &renderer.bind_group_layout,
                renderer.uniform_bind_group.clone(),
                renderer.render_pipeline.clone(),
                output_width,
                output_height,
            )
            .render(&surface, &buffer, stride);
            surface.present();
        }

        Ok(renderer)
    }
}

struct Renderer {
    surface: Option<wgpu::Surface<'static>>,
    surface_config: wgpu::SurfaceConfiguration,
    surface_scale: f64,
    render_pipeline: wgpu::RenderPipeline,
    device: wgpu::Device,
    queue: wgpu::Queue,
    sampler: wgpu::Sampler,
    bind_group_layout: wgpu::BindGroupLayout,
    state_uniform_buffer: wgpu::Buffer,
    window_uniform_buffer: wgpu::Buffer,
    camera_uniform_buffer: wgpu::Buffer,
    uniform_bind_group: wgpu::BindGroup,
    texture: Cached<(u32, u32), PreparedTexture>,
    aspect_ratio: Cached<f32>,
    blur_processor: Option<cap_camera_effects::BlurProcessor>,
    blur_processor_init_attempted: bool,
    blur_source_texture: Option<wgpu::Texture>,
    #[cfg(target_os = "macos")]
    native_converter: Option<NativeFrameConverter>,
    #[cfg(target_os = "macos")]
    native_converter_init_attempted: bool,
}

impl Renderer {
    async fn run(
        &mut self,
        window: WebviewWindow,
        default_state: CameraPreviewState,
        mut reconfigure: broadcast::Receiver<ReconfigureEvent>,
        camera_rx: flume::Receiver<PreviewCameraFrame>,
    ) {
        let mut resampler_frame = Cached::default();
        let Ok(mut scaler) = scaling::Context::get(
            Pixel::RGBA,
            1,
            1,
            Pixel::RGBA,
            1,
            1,
            scaling::Flags::empty(),
        )
        .map_err(|err| error!("Error initializing ffmpeg scaler: {err:?}")) else {
            return;
        };
        let mut source_dimensions = Cached::default();
        let mut last_render_at = None;

        // The camera's pixel buffer pool only recycles an IOSurface once its
        // CVPixelBuffer is released; holding the last couple of sample buffers
        // keeps the camera from writing into a surface the GPU is still
        // sampling.
        #[cfg(target_os = "macos")]
        let mut inflight_frames: std::collections::VecDeque<NativeCameraFrame> =
            std::collections::VecDeque::new();
        #[cfg(target_os = "macos")]
        let mut native_fallback_logged = false;

        let start_time = Instant::now();
        let startup_timeout = Duration::from_secs(5);
        let mut received_first_frame = false;
        let mut is_paused = false;

        let mut state = default_state;
        let mut needs_full_reconfigure = false;

        let pause_and_hide = || {
            window
                .run_on_main_thread({
                    let window = window.clone();
                    move || {
                        let _ = window.hide();
                    }
                })
                .ok();
        };

        'main_loop: loop {
            if is_paused {
                loop {
                    match reconfigure.recv().await {
                        Ok(ReconfigureEvent::Resume) => {
                            is_paused = false;
                            while camera_rx.try_recv().is_ok() {}
                            #[cfg(target_os = "macos")]
                            inflight_frames.clear();
                            if let Some(texture) = self.acquire_surface_texture() {
                                let (buffer, stride) =
                                    render_solid_frame([0x11, 0x11, 0x11, 0xFF], 5, 5);
                                PreparedTexture::init(
                                    self.device.clone(),
                                    self.queue.clone(),
                                    &self.sampler,
                                    &self.bind_group_layout,
                                    self.uniform_bind_group.clone(),
                                    self.render_pipeline.clone(),
                                    5,
                                    5,
                                )
                                .render(&texture, &buffer, stride);
                                texture.present();
                            }
                            break;
                        }
                        Ok(ReconfigureEvent::Shutdown) => {
                            self.cleanup_for_shutdown(&window).await;
                            return;
                        }
                        Ok(ReconfigureEvent::State(new_state)) => {
                            state = new_state;
                            needs_full_reconfigure = true;
                        }
                        Ok(ReconfigureEvent::WindowResized { width, height }) => {
                            self.reconfigure_gpu_surface(width, height);
                        }
                        Ok(ReconfigureEvent::Pause) => {}
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            self.cleanup_for_shutdown(&window).await;
                            return;
                        }
                    }
                }
            }

            if needs_full_reconfigure {
                needs_full_reconfigure = false;
                self.update_state_uniforms(&state);
                if state.background_blur == cap_project::BackgroundBlurMode::Off {
                    self.release_blur_resources();
                }
                source_dimensions = Cached::default();
                last_render_at = None;
                let aspect_ratio = self.aspect_ratio.get_latest_key().copied().unwrap_or(
                    if state.shape == CameraPreviewShape::Full {
                        WIDE_CAMERA_ASPECT_RATIO
                    } else {
                        1.0
                    },
                );
                self.aspect_ratio = Cached::default();
                if let Ok((width, height, scale)) =
                    resize_window(&window, &state, aspect_ratio, false)
                        .await
                        .map_err(|err| {
                            error!("Error resizing camera preview window after resume: {err}")
                        })
                {
                    self.surface_scale = scale;
                    self.reconfigure_gpu_surface(width, height);
                }
            }

            let frame_timeout = if received_first_frame {
                Duration::from_secs(5)
            } else if start_time.elapsed() < startup_timeout {
                startup_timeout.saturating_sub(start_time.elapsed())
            } else {
                Duration::from_secs(1)
            };

            let event = loop {
                if frame_timeout.is_zero() {
                    warn!("Camera preview timed out waiting for first frame, waiting for recovery");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue 'main_loop;
                }

                tokio::select! {
                    frame = camera_rx.recv_async() => {
                        match frame {
                            Ok(f) => break Ok(f),
                            Err(_) => {
                                is_paused = true;
                                pause_and_hide();
                                continue 'main_loop;
                            }
                        }
                    },
                    result = reconfigure.recv() => {
                        match result {
                            Ok(result) => break Err(result),
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => {
                                break Err(ReconfigureEvent::Shutdown);
                            }
                        }
                    },
                    _ = tokio::time::sleep(frame_timeout) => {
                        if received_first_frame {
                            warn!("Camera preview: frames stalled, waiting for feed refresh");
                            continue;
                        }
                        warn!("Camera preview: no frames received within startup timeout, waiting for recovery");
                        continue 'main_loop;
                    }
                }
            };

            match event {
                Ok(mut frame) => {
                    while let Ok(newer) = camera_rx.try_recv() {
                        frame = newer;
                    }

                    received_first_frame = true;
                    let now = Instant::now();
                    if !camera_preview_frame_due(last_render_at, now) {
                        continue 'main_loop;
                    }
                    last_render_at = Some(now);

                    #[cfg(target_os = "macos")]
                    let (source_width, source_height) = {
                        let Some(image_buf) = frame.sample_buf.image_buf() else {
                            continue 'main_loop;
                        };
                        (image_buf.width() as u32, image_buf.height() as u32)
                    };
                    #[cfg(not(target_os = "macos"))]
                    let (source_width, source_height) = (frame.inner.width(), frame.inner.height());

                    let aspect_ratio = source_width as f32 / source_height as f32;
                    if source_dimensions.update_key_and_should_init((source_width, source_height)) {
                        self.sync_ratio_uniform_and_resize_window_to_it(
                            &window,
                            &state,
                            aspect_ratio,
                        )
                        .await;
                    }

                    let surface_result = self.acquire_surface_texture();
                    if let Some(surface) = surface_result {
                        let surface_scale = self.surface_scale.max(1.0);
                        let toolbar_px = (TOOLBAR_HEIGHT as f64 * surface_scale).round() as u32;
                        let region_width = self.surface_config.width.max(1);
                        let region_height =
                            self.surface_config.height.saturating_sub(toolbar_px).max(1);
                        let blur_mode = blur_mode_from_project(state.background_blur);
                        let (output_width, output_height) = camera_preview_texture_dimensions(
                            source_width,
                            source_height,
                            region_width,
                            region_height,
                            blur_mode.is_some(),
                        );

                        #[cfg(target_os = "macos")]
                        {
                            match self.render_native_frame(
                                &frame,
                                output_width,
                                output_height,
                                blur_mode,
                                &surface,
                            ) {
                                Ok(()) => {
                                    surface.present();
                                    inflight_frames.push_back(frame);
                                    while inflight_frames.len() > 2 {
                                        inflight_frames.pop_front();
                                    }
                                }
                                Err(err) => {
                                    if !native_fallback_logged {
                                        native_fallback_logged = true;
                                        warn!(
                                            "Camera GPU-native preview unavailable ({err}); using CPU conversion"
                                        );
                                    }
                                    match cap_camera_ffmpeg::sample_buf_as_ffmpeg(&frame.sample_buf)
                                    {
                                        Ok(inner) => {
                                            if self.render_cpu_frame(
                                                &inner,
                                                output_width,
                                                output_height,
                                                blur_mode,
                                                &surface,
                                                &mut scaler,
                                                &mut resampler_frame,
                                            ) {
                                                surface.present();
                                            }
                                        }
                                        Err(err) => {
                                            error!(
                                                "Camera preview CPU fallback conversion failed: {err}"
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        #[cfg(not(target_os = "macos"))]
                        {
                            if self.render_cpu_frame(
                                &frame.inner,
                                output_width,
                                output_height,
                                blur_mode,
                                &surface,
                                &mut scaler,
                                &mut resampler_frame,
                            ) {
                                surface.present();
                            }
                        }
                    }
                }
                Err(ReconfigureEvent::State(new_state)) => {
                    trace!("CameraPreview/ReconfigureEvent.State({new_state:?})");

                    state = new_state;

                    let aspect_ratio = self.aspect_ratio.get_latest_key().copied().unwrap_or(
                        if state.shape == CameraPreviewShape::Full {
                            WIDE_CAMERA_ASPECT_RATIO
                        } else {
                            1.0
                        },
                    );

                    self.sync_ratio_uniform_and_resize_window_to_it(&window, &state, aspect_ratio)
                        .await;
                    self.update_state_uniforms(&state);
                    if state.background_blur == cap_project::BackgroundBlurMode::Off {
                        self.release_blur_resources();
                    }
                    if let Ok((width, height, scale)) =
                        resize_window(&window, &state, aspect_ratio, false)
                            .await
                            .map_err(|err| error!("Error resizing camera preview window: {err}"))
                    {
                        self.surface_scale = scale;
                        self.reconfigure_gpu_surface(width, height);
                    }
                }
                Err(ReconfigureEvent::WindowResized { width, height }) => {
                    trace!("CameraPreview/ReconfigureEvent.WindowResized({width}x{height})");
                    self.reconfigure_gpu_surface(width, height);
                }
                Err(ReconfigureEvent::Pause) => {
                    // When pausing, we hide the window to provide proper UX feedback.
                    // The WGPU Surface and Device are kept alive to avoid repeated GPU
                    // resource creation, which previously contributed to crashes.
                    //
                    // The corresponding show operation in windows.rs uses window.show()
                    // instead of panel.order_front_regardless() - see the comment there
                    // for why this is critical to avoid macOS crashes.
                    is_paused = true;
                    #[cfg(target_os = "macos")]
                    inflight_frames.clear();
                    window
                        .run_on_main_thread({
                            let window = window.clone();
                            move || {
                                let _ = window.hide();
                            }
                        })
                        .ok();
                }
                Err(ReconfigureEvent::Resume) => {
                    while camera_rx.try_recv().is_ok() {}
                    #[cfg(target_os = "macos")]
                    inflight_frames.clear();
                    if let Some(texture) = self.acquire_surface_texture() {
                        let (buffer, stride) = render_solid_frame([0x11, 0x11, 0x11, 0xFF], 5, 5);
                        PreparedTexture::init(
                            self.device.clone(),
                            self.queue.clone(),
                            &self.sampler,
                            &self.bind_group_layout,
                            self.uniform_bind_group.clone(),
                            self.render_pipeline.clone(),
                            5,
                            5,
                        )
                        .render(&texture, &buffer, stride);
                        texture.present();
                    }
                }
                Err(ReconfigureEvent::Shutdown) => {
                    self.cleanup_for_shutdown(&window).await;
                    return;
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn render_cpu_frame(
        &mut self,
        inner: &frame::Video,
        output_width: u32,
        output_height: u32,
        blur_mode: Option<cap_camera_effects::BlurMode>,
        surface: &SurfaceTexture,
        scaler: &mut scaling::Context,
        resampler_frame: &mut Cached<(u32, u32), frame::Video>,
    ) -> bool {
        let source_width = inner.width();
        let source_height = inner.height();

        let already_preview_rgba = inner.format() == Pixel::RGBA
            && output_width == source_width
            && output_height == source_height;
        let (frame_data, frame_stride) = if already_preview_rgba {
            (inner.data(0), inner.stride(0) as u32)
        } else {
            let resampler_frame =
                resampler_frame.get_or_init((output_width, output_height), frame::Video::empty);

            scaler.cached(
                inner.format(),
                source_width,
                source_height,
                format::Pixel::RGBA,
                output_width,
                output_height,
                ffmpeg::software::scaling::flag::Flags::FAST_BILINEAR,
            );

            if let Err(err) = scaler.run(inner, resampler_frame) {
                error!("Error rescaling frame with ffmpeg: {err:?}");
                return false;
            }

            (resampler_frame.data(0), resampler_frame.stride(0) as u32)
        };

        let blurred = if let Some(mode) = blur_mode {
            self.run_background_blur(frame_data, frame_stride, output_width, output_height, mode)
        } else {
            false
        };

        let prepared = self.texture.get_or_init((output_width, output_height), || {
            PreparedTexture::init(
                self.device.clone(),
                self.queue.clone(),
                &self.sampler,
                &self.bind_group_layout,
                self.uniform_bind_group.clone(),
                self.render_pipeline.clone(),
                output_width,
                output_height,
            )
        });

        if blurred {
            let Some(blur_output) = self
                .blur_processor
                .as_mut()
                .and_then(|p| p.process_returning_output())
            else {
                prepared.render(surface, frame_data, frame_stride);
                return true;
            };
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Blur Copy"),
                });
            encoder.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: blur_output,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &prepared.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d {
                    width: output_width,
                    height: output_height,
                    depth_or_array_layers: 1,
                },
            );
            self.queue.submit(std::iter::once(encoder.finish()));
            prepared.render_no_upload(surface);
        } else {
            prepared.render(surface, frame_data, frame_stride);
        }
        true
    }

    #[cfg(target_os = "macos")]
    fn ensure_native_converter(&mut self) -> bool {
        if self.native_converter.is_some() {
            return true;
        }
        if self.native_converter_init_attempted {
            return false;
        }
        self.native_converter_init_attempted = true;
        self.native_converter = NativeFrameConverter::new(&self.device);
        if self.native_converter.is_some() {
            info!("Camera GPU-native frame converter initialized");
            true
        } else {
            warn!("Failed to initialize camera GPU-native frame converter");
            false
        }
    }

    #[cfg(target_os = "macos")]
    fn render_native_frame(
        &mut self,
        frame: &NativeCameraFrame,
        output_width: u32,
        output_height: u32,
        blur_mode: Option<cap_camera_effects::BlurMode>,
        surface: &SurfaceTexture,
    ) -> Result<(), String> {
        let kind = classify_frame(frame).map_err(|err| err.to_string())?;
        if !self.ensure_native_converter() {
            return Err("GPU-native converter unavailable".to_string());
        }

        let use_blur = blur_mode.is_some() && self.ensure_blur_processor();

        if use_blur {
            self.ensure_blur_source_texture(output_width, output_height);
            let src_tex = self.blur_source_texture.as_ref().expect("just ensured");
            let dst_view = src_tex.create_view(&wgpu::TextureViewDescriptor::default());
            self.native_converter
                .as_ref()
                .expect("ensured above")
                .render_frame(&self.device, &self.queue, frame, &kind, &dst_view)
                .map_err(|err| err.to_string())?;

            if let (Some(mode), Some(processor)) = (blur_mode, self.blur_processor.as_mut()) {
                processor.process(&self.device, &self.queue, src_tex, mode);
            }

            let prepared = self.texture.get_or_init((output_width, output_height), || {
                PreparedTexture::init(
                    self.device.clone(),
                    self.queue.clone(),
                    &self.sampler,
                    &self.bind_group_layout,
                    self.uniform_bind_group.clone(),
                    self.render_pipeline.clone(),
                    output_width,
                    output_height,
                )
            });

            let blur_output = self
                .blur_processor
                .as_mut()
                .and_then(|p| p.process_returning_output())
                .ok_or_else(|| "blur output missing".to_string())?;
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Blur Copy"),
                });
            encoder.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: blur_output,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &prepared.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d {
                    width: output_width,
                    height: output_height,
                    depth_or_array_layers: 1,
                },
            );
            self.queue.submit(std::iter::once(encoder.finish()));
            prepared.render_no_upload(surface);
        } else {
            let prepared = self.texture.get_or_init((output_width, output_height), || {
                PreparedTexture::init(
                    self.device.clone(),
                    self.queue.clone(),
                    &self.sampler,
                    &self.bind_group_layout,
                    self.uniform_bind_group.clone(),
                    self.render_pipeline.clone(),
                    output_width,
                    output_height,
                )
            });
            let dst_view = prepared
                .texture
                .create_view(&wgpu::TextureViewDescriptor::default());
            self.native_converter
                .as_ref()
                .expect("ensured above")
                .render_frame(&self.device, &self.queue, frame, &kind, &dst_view)
                .map_err(|err| err.to_string())?;
            prepared.render_no_upload(surface);
        }

        Ok(())
    }

    fn run_background_blur(
        &mut self,
        frame_data: &[u8],
        frame_stride: u32,
        width: u32,
        height: u32,
        mode: cap_camera_effects::BlurMode,
    ) -> bool {
        if !self.ensure_blur_processor() {
            return false;
        }

        self.ensure_blur_source_texture(width, height);

        let (Some(src_tex), Some(processor)) = (
            self.blur_source_texture.as_ref(),
            self.blur_processor.as_mut(),
        ) else {
            return false;
        };

        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: src_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            frame_data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(frame_stride),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        processor.process(&self.device, &self.queue, src_tex, mode);
        true
    }

    // The blur processor owns an ONNX session plus several GPU textures, so it
    // is dropped as soon as blur is switched off instead of living for the
    // window's lifetime; turning blur back on re-runs the lazy init.
    fn release_blur_resources(&mut self) {
        if self.blur_processor.is_some() || self.blur_source_texture.is_some() {
            self.blur_processor = None;
            self.blur_source_texture = None;
            info!("Released camera background blur resources");
        }
        self.blur_processor_init_attempted = false;
    }

    fn ensure_blur_processor(&mut self) -> bool {
        if self.blur_processor.is_some() {
            return true;
        }

        // Low-spec: never spin up the ONNX/wgpu blur processor (the heaviest
        // cost in the preview). Both callers treat `false` as "blur unavailable"
        // and fall back to rendering the raw camera frame, so the preview stays
        // functional, just unblurred. The UI blur toggle is unaffected; it just
        // does not take visual effect on these machines.
        if is_low_spec_preview() {
            return false;
        }

        if self.blur_processor_init_attempted {
            return false;
        }

        self.blur_processor_init_attempted = true;
        match cap_camera_effects::BlurProcessor::new(&self.device, wgpu::TextureFormat::Rgba8Unorm)
        {
            Ok(processor) => {
                let mut processor = processor;
                processor.set_inference_interval(CAMERA_PREVIEW_BLUR_INFERENCE_INTERVAL);
                info!("Camera background blur processor initialized");
                self.blur_processor = Some(processor);
                true
            }
            Err(err) => {
                warn!("Failed to initialize camera background blur: {err}");
                false
            }
        }
    }

    fn ensure_blur_source_texture(&mut self, width: u32, height: u32) -> &wgpu::Texture {
        if self
            .blur_source_texture
            .as_ref()
            .is_none_or(|t| t.width() != width || t.height() != height)
        {
            self.blur_source_texture = Some(self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Blur Source"),
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
                    | wgpu::TextureUsages::COPY_SRC
                    | wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            }));
        }
        self.blur_source_texture.as_ref().unwrap()
    }

    async fn cleanup_for_shutdown(&mut self, window: &WebviewWindow) {
        info!("Camera preview shutdown requested. Cleaning up...");

        let _ = self.device.poll(wgpu::PollType::Poll);

        drop(std::mem::take(&mut self.texture));
        self.aspect_ratio = Cached::default();

        let surface = self.surface.take();
        let (drop_tx, drop_rx) = oneshot::channel();
        let _ = window.run_on_main_thread(move || {
            drop(surface);
            let _ = drop_tx.send(());
        });
        let _ = tokio::time::timeout(Duration::from_millis(250), drop_rx).await;

        self.device.destroy();

        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    fn acquire_surface_texture(&mut self) -> Option<wgpu::SurfaceTexture> {
        let surface = self.surface.as_ref()?;
        match surface.get_current_texture() {
            Ok(texture) => Some(texture),
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                tracing::warn!("Camera preview surface lost/outdated; reconfiguring");
                surface.configure(&self.device, &self.surface_config);
                match surface.get_current_texture() {
                    Ok(texture) => Some(texture),
                    Err(err) => {
                        tracing::error!(
                            "Camera preview surface still failing after reconfigure: {err:?}"
                        );
                        None
                    }
                }
            }
            Err(wgpu::SurfaceError::Timeout) => {
                tracing::debug!("Camera preview surface acquire timed out; skipping frame");
                None
            }
            Err(err) => {
                tracing::error!("Error getting camera renderer surface texture: {err:?}");
                None
            }
        }
    }

    fn reconfigure_gpu_surface(&mut self, window_width: u32, window_height: u32) {
        let scale = self.surface_scale.max(1.0);
        let surface_width = if window_width > 0 {
            ((window_width as f64 * scale).round() as u32).max(1)
        } else {
            1
        };
        let surface_height = if window_height > 0 {
            ((window_height as f64 * scale).round() as u32).max(1)
        } else {
            1
        };

        if self.surface_config.width != surface_width
            || self.surface_config.height != surface_height
        {
            self.surface_config.width = surface_width;
            self.surface_config.height = surface_height;
            if let Some(surface) = &self.surface {
                surface.configure(&self.device, &self.surface_config);
            }
        }

        let window_uniforms = WindowUniforms {
            window_height: window_height as f32,
            window_width: window_width as f32,
            toolbar_percentage: (TOOLBAR_HEIGHT * scale as f32) / self.surface_config.height as f32,
            _padding: 0.0,
        };
        self.queue.write_buffer(
            &self.window_uniform_buffer,
            0,
            bytemuck::cast_slice(&[window_uniforms]),
        );
    }

    fn update_state_uniforms(&self, state: &CameraPreviewState) {
        let clamped_size = clamp_size(state.size);
        let normalized_size =
            (clamped_size - MIN_CAMERA_SIZE) / (MAX_CAMERA_SIZE - MIN_CAMERA_SIZE);

        let state_uniforms = StateUniforms {
            shape: match state.shape {
                CameraPreviewShape::Round => 0.0,
                CameraPreviewShape::Square => 1.0,
                CameraPreviewShape::Full => 2.0,
            },
            size: normalized_size,
            mirrored: if state.mirrored { 1.0 } else { 0.0 },
            _padding: 0.0,
        };
        self.queue.write_buffer(
            &self.state_uniform_buffer,
            0,
            bytemuck::cast_slice(&[state_uniforms]),
        );
    }

    async fn sync_ratio_uniform_and_resize_window_to_it(
        &mut self,
        window: &WebviewWindow,
        state: &CameraPreviewState,
        aspect_ratio: f32,
    ) {
        if self.aspect_ratio.update_key_and_should_init(aspect_ratio) {
            let camera_uniforms = CameraUniforms {
                camera_aspect_ratio: aspect_ratio,
                _padding: 0.0,
            };
            self.queue.write_buffer(
                &self.camera_uniform_buffer,
                0,
                bytemuck::cast_slice(&[camera_uniforms]),
            );

            if let Ok((width, height, scale)) = resize_window(window, state, aspect_ratio, false)
                .await
                .map_err(|err| error!("Error resizing camera preview window: {err}"))
            {
                self.surface_scale = scale;
                self.reconfigure_gpu_surface(width, height);
            }
        }
    }
}

async fn resize_window(
    window: &WebviewWindow,
    state: &CameraPreviewState,
    aspect: f32,
    should_move: bool,
) -> anyhow::Result<(u32, u32, f64)> {
    trace!("CameraPreview/resize_window");

    let base = clamp_size(state.size);
    let aspect = if state.shape == CameraPreviewShape::Full {
        aspect.max(WIDE_CAMERA_ASPECT_RATIO)
    } else {
        1.0
    };
    let window_width = base * aspect;
    let window_height = base + TOOLBAR_HEIGHT;

    let window_width = window_width as u32;
    let window_height = window_height as u32;

    let (tx, rx) = oneshot::channel();
    window
        .run_on_main_thread({
            let window = window.clone();
            move || {
                let result: tauri::Result<(u32, u32, f64)> = (|| {
                    if should_move {
                        let (monitor_size, monitor_offset, monitor_scale_factor): (
                            PhysicalSize<u32>,
                            LogicalPosition<u32>,
                            _,
                        ) = if let Some(monitor) = window.current_monitor()? {
                            let size = monitor.position().to_logical(monitor.scale_factor());
                            (*monitor.size(), size, monitor.scale_factor())
                        } else {
                            (PhysicalSize::new(640, 360), LogicalPosition::new(0, 0), 1.0)
                        };

                        let x = (monitor_size.width as f64 / monitor_scale_factor
                            - window_width as f64
                            - 100.0) as u32
                            + monitor_offset.x;
                        let y = (monitor_size.height as f64 / monitor_scale_factor
                            - window_height as f64
                            - 100.0) as u32
                            + monitor_offset.y;

                        window.set_position(LogicalPosition::new(x, y))?;
                    } else if let Some(monitor) = window.current_monitor()? {
                        let scale_factor = monitor.scale_factor();
                        let monitor_pos = monitor.position().to_logical::<f64>(scale_factor);
                        let monitor_size = monitor.size().to_logical::<f64>(scale_factor);

                        let current_pos = window
                            .outer_position()
                            .map(|p| p.to_logical::<f64>(scale_factor))
                            .unwrap_or(monitor_pos);

                        let mut new_x = current_pos.x;
                        let mut new_y = current_pos.y;
                        let new_width = window_width as f64;
                        let new_height = window_height as f64;

                        if new_x + new_width > monitor_pos.x + monitor_size.width {
                            new_x = monitor_pos.x + monitor_size.width - new_width;
                        }

                        if new_y + new_height > monitor_pos.y + monitor_size.height {
                            new_y = monitor_pos.y + monitor_size.height - new_height;
                        }

                        if new_x < monitor_pos.x {
                            new_x = monitor_pos.x;
                        }

                        if new_y < monitor_pos.y {
                            new_y = monitor_pos.y;
                        }

                        if (new_x - current_pos.x).abs() > 1.0
                            || (new_y - current_pos.y).abs() > 1.0
                        {
                            window.set_position(LogicalPosition::new(new_x, new_y))?;
                        }
                    }

                    window.set_size(LogicalSize::new(window_width, window_height))?;

                    let scale_factor = window
                        .scale_factor()
                        .ok()
                        .filter(|scale| *scale > 0.0)
                        .unwrap_or(DEFAULT_SURFACE_SCALE);

                    Ok((window_width, window_height, scale_factor))
                })();

                tx.send(result).ok();
            }
        })
        .context("Failed to run window resize on main thread")?;

    rx.await
        .context("Failed to receive window resize result")?
        .map_err(anyhow::Error::new)
}

#[cfg(test)]
mod tests {
    use super::{
        CAMERA_PREVIEW_MAX_TEXTURE_HEIGHT, CAMERA_PREVIEW_MAX_TEXTURE_WIDTH,
        camera_preview_texture_dimensions, preferred_alpha_mode, wait_for_shutdown_signal,
    };
    use std::thread;
    use tokio::{runtime::Runtime, sync::oneshot, time::Duration};
    use wgpu::CompositeAlphaMode;

    #[test]
    fn texture_covers_square_region_without_upscaling() {
        let (width, height) = camera_preview_texture_dimensions(1280, 720, 460, 460, false);
        let cover_scale = (460.0 / width as f64).max(460.0 / height as f64);
        assert!(
            cover_scale <= 1.0,
            "texture {width}x{height} would upscale to cover a 460x460 region (scale {cover_scale})"
        );
    }

    #[test]
    fn texture_dimensions_stay_within_caps() {
        let (width, height) = camera_preview_texture_dimensions(1920, 1080, 4000, 2200, false);
        assert!(width <= CAMERA_PREVIEW_MAX_TEXTURE_WIDTH);
        assert!(height <= CAMERA_PREVIEW_MAX_TEXTURE_HEIGHT);
    }

    #[test]
    fn preferred_alpha_mode_avoids_unsupported_inherit_fallback() {
        assert_eq!(
            preferred_alpha_mode(&[CompositeAlphaMode::Opaque]),
            CompositeAlphaMode::Opaque
        );
    }

    #[test]
    fn preferred_alpha_mode_keeps_transparent_modes_when_supported() {
        assert_eq!(
            preferred_alpha_mode(&[
                CompositeAlphaMode::Opaque,
                CompositeAlphaMode::PreMultiplied,
            ]),
            CompositeAlphaMode::PreMultiplied
        );
        assert_eq!(
            preferred_alpha_mode(&[
                CompositeAlphaMode::Opaque,
                CompositeAlphaMode::PostMultiplied,
            ]),
            CompositeAlphaMode::PostMultiplied
        );
    }

    #[test]
    fn preferred_alpha_mode_uses_other_supported_fallbacks() {
        assert_eq!(
            preferred_alpha_mode(&[CompositeAlphaMode::Auto]),
            CompositeAlphaMode::Auto
        );
        assert_eq!(
            preferred_alpha_mode(&[CompositeAlphaMode::Inherit]),
            CompositeAlphaMode::Inherit
        );
        assert_eq!(preferred_alpha_mode(&[]), CompositeAlphaMode::Opaque);
    }

    #[test]
    fn wait_for_shutdown_signal_can_run_from_plain_thread() {
        let runtime = Runtime::new().unwrap();
        let (tx, rx) = oneshot::channel();

        let handle = thread::spawn(move || {
            wait_for_shutdown_signal(&runtime, rx, Duration::from_millis(100));
        });

        tx.send(()).ok();
        handle.join().unwrap();
    }
}

fn blur_mode_from_project(
    mode: cap_project::BackgroundBlurMode,
) -> Option<cap_camera_effects::BlurMode> {
    match mode {
        cap_project::BackgroundBlurMode::Off => None,
        cap_project::BackgroundBlurMode::Light => Some(cap_camera_effects::BlurMode::Light),
        cap_project::BackgroundBlurMode::Heavy => Some(cap_camera_effects::BlurMode::Heavy),
    }
}

fn render_solid_frame(color: [u8; 4], width: u32, height: u32) -> (Vec<u8>, u32) {
    let pixel_count = (height * width) as usize;
    let buffer: Vec<u8> = color
        .iter()
        .cycle()
        .take(pixel_count * 4)
        .copied()
        .collect();

    (buffer, 4 * width)
}

pub struct PreparedTexture {
    texture: wgpu::Texture,
    bind_group: wgpu::BindGroup,
    uniform_bind_group: wgpu::BindGroup,
    render_pipeline: wgpu::RenderPipeline,
    device: wgpu::Device,
    queue: wgpu::Queue,
    width: u32,
    height: u32,
}

impl PreparedTexture {
    #[allow(clippy::too_many_arguments)]
    pub fn init(
        device: wgpu::Device,
        queue: wgpu::Queue,
        sampler: &wgpu::Sampler,
        bind_group_layout: &wgpu::BindGroupLayout,
        uniform_bind_group: wgpu::BindGroup,
        render_pipeline: wgpu::RenderPipeline,
        width: u32,
        height: u32,
    ) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Texture"),
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
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });

        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Texture Bind Group"),
            layout: bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        });

        Self {
            texture,
            bind_group,
            uniform_bind_group,
            render_pipeline,
            device,
            queue,
            width,
            height,
        }
    }

    pub fn render_no_upload(&self, surface: &SurfaceTexture) {
        let surface_view = surface
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &surface_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.0,
                            g: 0.0,
                            b: 0.0,
                            a: 0.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            render_pass.set_pipeline(&self.render_pipeline);
            render_pass.set_bind_group(0, &self.bind_group, &[]);
            render_pass.set_bind_group(1, &self.uniform_bind_group, &[]);
            render_pass.draw(0..6, 0..1);
        }

        self.queue.submit(Some(encoder.finish()));
    }

    pub fn render(&self, surface: &SurfaceTexture, buffer: &[u8], stride: u32) {
        let surface_view = surface
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            buffer,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: Some(self.height),
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &surface_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.0,
                            g: 0.0,
                            b: 0.0,
                            a: 0.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            render_pass.set_pipeline(&self.render_pipeline);
            render_pass.set_bind_group(0, &self.bind_group, &[]);
            render_pass.set_bind_group(1, &self.uniform_bind_group, &[]);
            render_pass.draw(0..6, 0..1);
        }

        self.queue.submit(Some(encoder.finish()));
    }
}

struct Cached<K, V = ()> {
    value: Option<(K, V)>,
}

impl<K, V> Default for Cached<K, V> {
    fn default() -> Self {
        Self { value: None }
    }
}

impl<K: PartialEq, V> Cached<K, V> {
    pub fn get_or_init(&mut self, key: K, init: impl FnOnce() -> V) -> &mut V {
        if self.value.as_ref().is_none_or(|(k, _)| *k != key) {
            self.value = Some((key, init()));
        }

        &mut self.value.as_mut().expect("checked above").1
    }

    pub fn get_latest_key(&self) -> Option<&K> {
        self.value.as_ref().map(|(k, _)| k)
    }
}

impl<K: PartialEq> Cached<K, ()> {
    pub fn update_key_and_should_init(&mut self, key: K) -> bool {
        if self.value.as_ref().is_none_or(|(k, _)| *k != key) {
            self.value = Some((key, ()));
            true
        } else {
            false
        }
    }
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct StateUniforms {
    shape: f32,
    size: f32,
    mirrored: f32,
    _padding: f32,
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct WindowUniforms {
    window_height: f32,
    window_width: f32,
    toolbar_percentage: f32,
    _padding: f32,
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct CameraUniforms {
    camera_aspect_ratio: f32,
    _padding: f32,
}
