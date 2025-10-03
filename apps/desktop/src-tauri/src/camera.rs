use anyhow::{Context, anyhow};
use cap_recording::feeds::{
    self,
    camera::{CameraFeed, RawCameraFrame},
};
use ffmpeg::{
    format::{self, Pixel},
    frame,
    software::scaling,
};
use kameo::actor::ActorRef;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{sync::Arc, thread};
use tauri::{LogicalPosition, LogicalSize, PhysicalSize, WebviewWindow};
use tokio::{
    runtime::Runtime,
    sync::{broadcast, oneshot},
    task::LocalSet,
};
use tracing::{error, info, trace};
use wgpu::{CompositeAlphaMode, SurfaceTexture};

static TOOLBAR_HEIGHT: f32 = 56.0; // also defined in Typescript

// We scale up the GPU surfaces resolution by this amount from the OS window's size.
// This smooths out the curved edges of the window.
// Basically poor man's MSAA
static GPU_SURFACE_SCALE: u32 = 4;

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CameraPreviewSize {
    #[default]
    Sm,
    Lg,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CameraPreviewShape {
    #[default]
    Round,
    Square,
    Full,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct CameraPreviewState {
    size: CameraPreviewSize,
    shape: CameraPreviewShape,
    mirrored: bool,
}

pub struct CameraPreviewManager {
    store: Result<Arc<tauri_plugin_store::Store<tauri::Wry>>, String>,
    preview: Option<InitializedCameraPreview>,
}

impl CameraPreviewManager {
    /// Create a new camera preview manager.
    pub fn new(app: &tauri::AppHandle) -> Self {
        Self {
            store: tauri_plugin_store::StoreBuilder::new(app, "cameraPreview")
                .build()
                .map_err(|err| format!("Error initializing camera preview store: {err}")),
            preview: None,
        }
    }

    /// Get the current state of the camera window.
    pub fn get_state(&self) -> anyhow::Result<CameraPreviewState> {
        Ok(self
            .store
            .as_ref()
            .map_err(|err| anyhow!("{err}"))?
            .get("state")
            .and_then(|v| serde_json::from_value(v).ok().unwrap_or_default())
            .unwrap_or_default())
    }

    /// Save the current state of the camera window.
    pub fn set_state(&self, state: CameraPreviewState) -> anyhow::Result<()> {
        let store = self.store.as_ref().map_err(|err| anyhow!("{err}"))?;
        store.set("state", serde_json::to_value(&state)?);
        store.save()?;

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

    /// Initialize the camera preview for a specific Tauri window
    pub async fn init_window(
        &mut self,
        window: WebviewWindow,
        actor: ActorRef<CameraFeed>,
    ) -> anyhow::Result<()> {
        let (camera_tx, camera_rx) = flume::bounded(4);

        let default_state = self
            .get_state()
            .map_err(|err| error!("Error getting camera preview state: {err}"))
            .unwrap_or_default();

        let (reconfigure, reconfigure_rx) = broadcast::channel(1);
        let mut renderer =
            InitializedCameraPreview::init_wgpu(window.clone(), &default_state).await?;
        window.show().ok();

        let rt = Runtime::new().expect("Failed to get Tokio runtime!");
        thread::spawn(move || {
            LocalSet::new().block_on(
                &rt,
                renderer.run(window, default_state, reconfigure_rx, camera_rx),
            )
        });

        self.preview = Some(InitializedCameraPreview { reconfigure });

        actor
            .ask(feeds::camera::AddSender(camera_tx))
            .await
            .context("Error attaching camera feed consumer")?;

        Ok(())
    }

    /// Called by Tauri's event loop in response to a window destroy event.
    pub fn on_window_close(&mut self) {
        if let Some(preview) = self.preview.take() {
            info!("Camera preview window closed.");
            preview
                .reconfigure
                .send(ReconfigureEvent::Shutdown)
                .map_err(|err| error!("Error sending camera preview shutdown event: {err}"))
                .ok();
        }
    }
}

#[derive(Clone)]
enum ReconfigureEvent {
    State(CameraPreviewState),
    Shutdown,
}

struct InitializedCameraPreview {
    reconfigure: broadcast::Sender<ReconfigureEvent>,
}

impl InitializedCameraPreview {
    async fn init_wgpu(
        window: WebviewWindow,
        default_state: &CameraPreviewState,
    ) -> anyhow::Result<Renderer> {
        let aspect = if default_state.shape == CameraPreviewShape::Full {
            16.0 / 9.0
        } else {
            1.0
        };

        let size =
            resize_window(&window, default_state, aspect).context("Error resizing Tauri window")?;

        let (tx, rx) = oneshot::channel();
        window
            .run_on_main_thread({
                let window = window.clone();
                move || {
                    let instance = wgpu::Instance::default();
                    let surface = instance.create_surface(window.clone());
                    tx.send((instance, surface)).ok();
                }
            })
            .with_context(|| "Failed to initialize wgpu instance")?;

        let (instance, surface) = rx
            .await
            .with_context(|| "Failed to receive initialized wgpu instance and surface")?;
        let surface = surface.with_context(|| "Failed to initialize wgpu surface")?;

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::default(),
                force_fallback_adapter: false,
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
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT, // Add FRAGMENT here
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
        let alpha_mode = if surface_capabilities
            .alpha_modes
            .contains(&CompositeAlphaMode::PreMultiplied)
        {
            CompositeAlphaMode::PreMultiplied
        } else if surface_capabilities
            .alpha_modes
            .contains(&CompositeAlphaMode::PostMultiplied)
        {
            CompositeAlphaMode::PostMultiplied
        } else {
            CompositeAlphaMode::Inherit
        };

        let surface_config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: swapchain_format,
            width: size.0,
            height: size.1,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
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
            surface,
            surface_config,
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
        };

        renderer.update_state_uniforms(default_state);
        renderer.sync_ratio_uniform_and_resize_window_to_it(&window, default_state, aspect);
        renderer.reconfigure_gpu_surface(size.0, size.1);

        // We initialize and render a blank color fallback.
        // This is shown until the camera initializes and the first frame is rendered.
        if let Ok(surface) = renderer
            .surface
            .get_current_texture()
            .map_err(|err| error!("Error getting camera renderer surface texture: {err:?}"))
        {
            let output_width = 5;
            let output_height = 5;

            let (buffer, stride) = render_solid_frame(
                [0x11, 0x11, 0x11, 0xFF], // #111111
                output_width,
                output_height,
            );

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
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
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
}

impl Renderer {
    async fn run(
        &mut self,
        window: WebviewWindow,
        default_state: CameraPreviewState,
        mut reconfigure: broadcast::Receiver<ReconfigureEvent>,
        camera_rx: flume::Receiver<RawCameraFrame>,
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

        let mut state = default_state;
        while let Some(event) = loop {
            tokio::select! {
                frame = camera_rx.recv_async() => break frame.ok().map(Ok),
                result = reconfigure.recv() => {
                    if let Ok(result) = result {
                        break Some(Err(result))
                    } else {
                        continue;
                    }
                },
            }
        } {
            match event {
                Ok(frame) => {
                    let aspect_ratio = frame.frame.width() as f32 / frame.frame.height() as f32;
                    self.sync_ratio_uniform_and_resize_window_to_it(&window, &state, aspect_ratio);

                    if let Ok(surface) = self.surface.get_current_texture().map_err(|err| {
                        error!("Error getting camera renderer surface texture: {err:?}")
                    }) {
                        let output_width = 1280;
                        let output_height = (1280.0 / aspect_ratio) as u32;

                        let resampler_frame = resampler_frame
                            .get_or_init((output_width, output_height), frame::Video::empty);

                        scaler.cached(
                            frame.frame.format(),
                            frame.frame.width(),
                            frame.frame.height(),
                            format::Pixel::RGBA,
                            output_width,
                            output_height,
                            ffmpeg::software::scaling::flag::Flags::FAST_BILINEAR,
                        );

                        if let Err(err) = scaler.run(&frame.frame, resampler_frame) {
                            error!("Error rescaling frame with ffmpeg: {err:?}");
                            continue;
                        }

                        self.texture
                            .get_or_init((output_width, output_height), || {
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
                            })
                            .render(
                                &surface,
                                resampler_frame.data(0),
                                resampler_frame.stride(0) as u32,
                            );
                        surface.present();
                    }
                }
                Err(ReconfigureEvent::State(new_state)) => {
                    trace!("CameraPreview/ReconfigureEvent.State({new_state:?})");

                    state = new_state;

                    let aspect_ratio = self
                        .aspect_ratio
                        .get_latest_key()
                        .copied()
                        // Aspect ratio is hardcoded until we can derive it from the camera feed
                        .unwrap_or(if state.shape == CameraPreviewShape::Full {
                            16.0 / 9.0
                        } else {
                            1.0
                        });

                    self.sync_ratio_uniform_and_resize_window_to_it(&window, &state, aspect_ratio);
                    self.update_state_uniforms(&state);
                    if let Ok((width, height)) = resize_window(&window, &state, aspect_ratio)
                        .map_err(|err| error!("Error resizing camera preview window: {err}"))
                    {
                        self.reconfigure_gpu_surface(width, height);
                    }
                }
                Err(ReconfigureEvent::Shutdown) => return,
            }
        }

        info!("Camera feed completed. Closing preview window...");
        window.close().ok();
        self.device.destroy();
    }

    /// Reconfigure the GPU surface if the window has changed size
    fn reconfigure_gpu_surface(&mut self, window_width: u32, window_height: u32) {
        self.surface_config.width = if window_width > 0 {
            window_width * GPU_SURFACE_SCALE
        } else {
            1
        };
        self.surface_config.height = if window_height > 0 {
            window_height * GPU_SURFACE_SCALE
        } else {
            1
        };
        self.surface.configure(&self.device, &self.surface_config);

        let window_uniforms = WindowUniforms {
            window_height: window_height as f32,
            window_width: window_width as f32,
            toolbar_percentage: (TOOLBAR_HEIGHT * GPU_SURFACE_SCALE as f32)
                / self.surface_config.height as f32,
            _padding: 0.0,
        };
        self.queue.write_buffer(
            &self.window_uniform_buffer,
            0,
            bytemuck::cast_slice(&[window_uniforms]),
        );
    }

    /// Update the uniforms which hold the camera preview state
    fn update_state_uniforms(&self, state: &CameraPreviewState) {
        let state_uniforms = StateUniforms {
            shape: match state.shape {
                CameraPreviewShape::Round => 0.0,
                CameraPreviewShape::Square => 1.0,
                CameraPreviewShape::Full => 2.0,
            },
            size: match state.size {
                CameraPreviewSize::Sm => 0.0,
                CameraPreviewSize::Lg => 1.0,
            },
            mirrored: if state.mirrored { 1.0 } else { 0.0 },
            _padding: 0.0,
        };
        self.queue.write_buffer(
            &self.state_uniform_buffer,
            0,
            bytemuck::cast_slice(&[state_uniforms]),
        );
    }

    /// Update the uniforms which hold the camera aspect ratio if it's changed,
    /// and resize the window to match the new aspect ratio if required.
    fn sync_ratio_uniform_and_resize_window_to_it(
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

            if let Ok((width, height)) = resize_window(window, state, aspect_ratio)
                .map_err(|err| error!("Error resizing camera preview window: {err}"))
            {
                self.reconfigure_gpu_surface(width, height);
            }
        }
    }
}

/// Resize the OS window to the correct size,
/// based on configuration
fn resize_window(
    window: &WebviewWindow,
    state: &CameraPreviewState,
    aspect: f32,
) -> tauri::Result<(u32, u32)> {
    trace!("CameraPreview/resize_window");

    let base: f32 = if state.size == CameraPreviewSize::Sm {
        230.0
    } else {
        400.0
    };
    let window_width = if state.shape == CameraPreviewShape::Full {
        if aspect >= 1.0 { base * aspect } else { base }
    } else {
        base
    };
    let window_height = if state.shape == CameraPreviewShape::Full {
        if aspect >= 1.0 { base } else { base / aspect }
    } else {
        base
    } + TOOLBAR_HEIGHT;

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

    let x = (monitor_size.width as f64 / monitor_scale_factor - window_width as f64 - 100.0) as u32
        + monitor_offset.x;
    let y = (monitor_size.height as f64 / monitor_scale_factor - window_height as f64 - 100.0)
        as u32
        + monitor_offset.y;

    window.set_size(LogicalSize::new(window_width, window_height))?;
    window.set_position(LogicalPosition::new(x, y))?;

    Ok((window_width as u32, window_height as u32))
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
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
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

    pub fn render(&self, surface: &SurfaceTexture, buffer: &[u8], stride: u32) {
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
    /// Updates the key and returns `true` when the key was changed.
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
