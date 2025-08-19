use anyhow::Context;
use cap_media::feeds::RawCameraFrame;
use ffmpeg::{
    format::{self, Pixel},
    frame,
    software::scaling,
};
use flume::Receiver;
use futures::{executor::block_on, future::Either};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::HashMap,
    pin::pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use tauri::{LogicalPosition, LogicalSize, Manager, PhysicalSize, WebviewWindow, Wry};
use tauri_plugin_store::Store;
use tokio::{
    sync::{broadcast, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};
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
pub struct CameraWindowState {
    size: CameraPreviewSize,
    shape: CameraPreviewShape,
    mirrored: bool,
}

pub struct CameraPreview {
    #[allow(clippy::type_complexity)]
    reconfigure: (
        broadcast::Sender<Option<(u32, u32)>>,
        broadcast::Receiver<Option<(u32, u32)>>,
    ),
    // TODO: Remove this and rely on `camera_feed.take()`
    cancel: CancellationToken,
    loading: Arc<AtomicBool>,
    store: Arc<Store<Wry>>,

    camera_preview: (
        flume::Sender<RawCameraFrame>,
        flume::Receiver<RawCameraFrame>,
    ),
}

impl CameraPreview {
    pub fn init(manager: &impl Manager<Wry>) -> tauri_plugin_store::Result<Self> {
        // let (camera_tx, camera_rx) = flume::bounded::<RawCameraFrame>(4);

        Ok(Self {
            reconfigure: broadcast::channel(1),
            cancel: CancellationToken::new(),
            loading: Arc::new(AtomicBool::new(false)),
            store: tauri_plugin_store::StoreBuilder::new(manager, "cameraPreview").build()?,
            camera_preview: flume::bounded::<RawCameraFrame>(4), // Mutex::new(None),
        })
    }

    pub fn get_sender(&self) -> flume::Sender<RawCameraFrame> {
        self.camera_preview.0.clone()
    }

    pub fn shutdown(&self) {
        println!("DO SHUTDOWN");
        self.cancel.cancel();
    }

    pub async fn init_preview_window(&self, window: WebviewWindow) -> anyhow::Result<()> {
        let camera_rx = self.camera_preview.1.clone();
        let cancel = self.cancel.clone();

        self.loading.store(true, Ordering::Relaxed);

        let mut renderer = Renderer::init(window.clone()).await?;

        let store = self.store.clone();
        let mut reconfigure = self.reconfigure.1.resubscribe();
        let loading_state = self.loading.clone();
        thread::spawn(move || {
            let mut window_visible = false;
            let mut first = true;
            let mut loading = true;
            let mut window_size = None;
            let mut resampler_frame = Cached::default();
            let mut aspect_ratio = None;
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

            info!("Camera preview initialized!");
            while let Some((frame, reconfigure)) = block_on({
                let camera_rx = &camera_rx;
                let reconfigure = &mut reconfigure;

                async {
                    // Triggers the first paint
                    if first {
                        // We don't set `first = false` as that is done within the loop.
                        return Some((None, true));
                    }

                    match futures::future::select(
                        pin!(camera_rx.recv_async()),
                        futures::future::select(pin!(reconfigure.recv()), pin!(cancel.cancelled())),
                    )
                    .await
                    {
                        Either::Left((frame, _)) => frame.ok().map(|f| (Some(f.frame), false)),
                        Either::Right((Either::Left((event, _)), _)) => {
                            if let Ok(Some((width, height))) = event {
                                window_size = Some((width, height));
                            }

                            Some((None, true))
                        }
                        Either::Right((Either::Right(_), _)) => None,
                    }
                }
            }) {
                let window_resize_required =
                    if reconfigure && renderer.refresh_state(&store) || first {
                        first = false;
                        renderer.update_state_uniforms();
                        println!("WINDOW RESIZE REQUESTED A");
                        true
                    } else if let Some(frame) = frame.as_ref()
                        && renderer.frame_info.update_key_and_should_init((
                            frame.format(),
                            frame.width(),
                            frame.height(),
                        ))
                    {
                        aspect_ratio = Some(frame.width() as f32 / frame.height() as f32);
                        println!(
                            "NEW SIZE {:?} {:?} {:?}",
                            frame.width(),
                            frame.height(),
                            aspect_ratio
                        );

                        println!("WINDOW RESIZE REQUESTED B");
                        true
                    } else {
                        false
                    };

                let camera_aspect_ratio =
                    aspect_ratio.unwrap_or(if renderer.state.shape == CameraPreviewShape::Full {
                        16.0 / 9.0
                    } else {
                        1.0
                    });

                if window_resize_required {
                    println!("DO WINDOW RESIZE");

                    renderer.update_camera_aspect_ratio_uniforms(camera_aspect_ratio);

                    match renderer.resize_window(camera_aspect_ratio) {
                        Ok(size) => window_size = Some(size),
                        Err(err) => {
                            error!("Error updating window size: {err:?}");
                            continue;
                        }
                    }
                }

                let (window_width, window_height) = match window_size {
                    Some(s) => s,
                    // Calling `window.outer_size` will hang when a native menu is opened.
                    // So we only callback to it if absolute required as it could randomly hang.
                    None => match renderer
                        .window
                        .inner_size()
                        .and_then(|size| Ok(size.to_logical(renderer.window.scale_factor()?)))
                    {
                        Ok(size) => {
                            window_size = Some((size.width, size.height));
                            (size.width, size.height)
                        }
                        Err(err) => {
                            error!("Error getting window size: {err:?}");
                            continue;
                        }
                    },
                };

                println!(
                    "INFO {:?} {:?} {:?}",
                    camera_aspect_ratio, window_width, window_height
                );

                if let Err(err) = renderer.reconfigure_gpu_surface(window_width, window_height) {
                    error!("Error reconfiguring GPU surface: {err:?}");
                    continue;
                }

                if let Ok(surface) = renderer
                    .surface
                    .get_current_texture()
                    .map_err(|err| error!("Error getting camera renderer surface texture: {err:?}"))
                {
                    let output_width = 1280;
                    let output_height = (1280.0 / camera_aspect_ratio) as u32;

                    let new_texture_value = if let Some(frame) = frame {
                        if loading {
                            loading_state.store(false, Ordering::Relaxed);
                            loading = false;
                        }

                        let resampler_frame = resampler_frame
                            .get_or_init((output_width, output_height), frame::Video::empty);

                        scaler.cached(
                            frame.format(),
                            frame.width(),
                            frame.height(),
                            format::Pixel::RGBA,
                            output_width,
                            output_height,
                            ffmpeg::software::scaling::flag::Flags::FAST_BILINEAR,
                        );

                        if let Err(err) = scaler.run(&frame, resampler_frame) {
                            error!("Error rescaling frame with ffmpeg: {err:?}");
                            continue;
                        }

                        Some((
                            resampler_frame.data(0).to_vec(),
                            resampler_frame.stride(0) as u32,
                        ))
                    } else if loading {
                        let (buffer, stride) = render_solid_frame(
                            [0x11, 0x11, 0x11, 0xFF], // #111111
                            output_width,
                            output_height,
                        );

                        Some((buffer, stride))
                    } else {
                        None // This will reuse the existing texture
                    };

                    renderer.render(
                        surface,
                        new_texture_value.as_ref().map(|(b, s)| (&**b, *s)),
                        output_width,
                        output_height,
                    );
                }

                if !window_visible {
                    window_visible = true;
                    if let Err(err) = renderer.window.show() {
                        error!("Failed to show camera preview window: {}", err);
                    }
                }
            }

            warn!("Camera preview shutdown!");
            renderer.device.destroy();
            window.close().ok();
        });

        Ok(())
    }

    /// Save the current state of the camera window.
    pub fn save(&self, state: &CameraWindowState) -> tauri_plugin_store::Result<()> {
        self.store.set("state", serde_json::to_value(state)?);
        self.store.save()?;
        self.reconfigure.0.send(None).ok();
        Ok(())
    }

    /// Wait for the camera to load.
    pub async fn wait_for_camera_to_load(&self) {
        // The webview is generally slow to load so it's rare this will actually loop.
        while self.loading.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Update the size of the window.
    /// Using `window.outer_size` just never resolves when a native menu is open.
    pub fn update_window_size(&self, width: u32, height: u32) {
        self.reconfigure.0.send(Some((width, height))).ok();
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
    uniform_buffer: wgpu::Buffer,
    window_uniform_buffer: wgpu::Buffer,
    camera_uniform_buffer: wgpu::Buffer,
    uniform_bind_group: wgpu::BindGroup,
    window: tauri::WebviewWindow<Wry>,

    state: CameraWindowState,
    frame_info: Cached<(format::Pixel, u32, u32)>,
    surface_size: Cached<(u32, u32)>,
    texture: Cached<(u32, u32), (wgpu::Texture, wgpu::TextureView, wgpu::BindGroup)>,
}

impl Renderer {
    /// Initialize a new renderer for a specific Tauri window.
    async fn init(window: WebviewWindow) -> anyhow::Result<Self> {
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

        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Uniform Buffer"),
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
                    resource: uniform_buffer.as_entire_binding(),
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
            // These will be sorted out by the main event loop
            width: 0,
            height: 0,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Ok(Self {
            surface,
            surface_config,
            render_pipeline,
            device,
            queue,
            sampler,
            bind_group_layout,
            uniform_buffer,
            window_uniform_buffer,
            camera_uniform_buffer,
            uniform_bind_group,
            window,

            state: Default::default(),
            frame_info: Cached::default(),
            surface_size: Cached::default(),
            texture: Cached::default(),
        })
    }

    /// Update the local cache of the camera state
    fn refresh_state(&mut self, store: &Store<tauri::Wry>) -> bool {
        let current = self.state.clone();

        self.state = store
            .get("state")
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();

        current != self.state
    }

    /// Resize the OS window to the correct size
    fn resize_window(&self, aspect: f32) -> tauri::Result<(u32, u32)> {
        let base: f32 = if self.state.size == CameraPreviewSize::Sm {
            230.0
        } else {
            400.0
        };
        let window_width = if self.state.shape == CameraPreviewShape::Full {
            if aspect >= 1.0 { base * aspect } else { base }
        } else {
            base
        };
        let window_height = if self.state.shape == CameraPreviewShape::Full {
            if aspect >= 1.0 { base } else { base / aspect }
        } else {
            base
        } + TOOLBAR_HEIGHT;

        let (monitor_size, monitor_offset, monitor_scale_factor): (
            PhysicalSize<u32>,
            LogicalPosition<u32>,
            _,
        ) = if let Some(monitor) = self.window.current_monitor()? {
            let size = monitor.position().to_logical(monitor.scale_factor());
            (*monitor.size(), size, monitor.scale_factor())
        } else {
            (PhysicalSize::new(640, 360), LogicalPosition::new(0, 0), 1.0)
        };

        let x = (monitor_size.width as f64 / monitor_scale_factor - window_width as f64 - 100.0)
            as u32
            + monitor_offset.x;
        let y = (monitor_size.height as f64 / monitor_scale_factor - window_height as f64 - 100.0)
            as u32
            + monitor_offset.y;

        self.window
            .set_size(LogicalSize::new(window_width, window_height))?;
        self.window.set_position(LogicalPosition::new(x, y))?;

        Ok((window_width as u32, window_height as u32))
    }

    /// Reconfigure the GPU surface if the window has changed size
    fn reconfigure_gpu_surface(
        &mut self,
        window_width: u32,
        window_height: u32,
    ) -> tauri::Result<()> {
        self.surface_size
            .get_or_init((window_width, window_height), || {
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
            });

        Ok(())
    }

    /// Update the uniforms which hold the camera preview state
    fn update_state_uniforms(&self) {
        let state_uniforms = StateUniforms {
            shape: match self.state.shape {
                CameraPreviewShape::Round => 0.0,
                CameraPreviewShape::Square => 1.0,
                CameraPreviewShape::Full => 2.0,
            },
            size: match self.state.size {
                CameraPreviewSize::Sm => 0.0,
                CameraPreviewSize::Lg => 1.0,
            },
            mirrored: if self.state.mirrored { 1.0 } else { 0.0 },
            _padding: 0.0,
        };
        self.queue.write_buffer(
            &self.uniform_buffer,
            0,
            bytemuck::cast_slice(&[state_uniforms]),
        );
    }

    /// Update the uniforms which hold the camera aspect ratio
    fn update_camera_aspect_ratio_uniforms(&self, camera_aspect_ratio: f32) {
        let camera_uniforms = CameraUniforms {
            camera_aspect_ratio,
            _padding: 0.0,
        };
        self.queue.write_buffer(
            &self.camera_uniform_buffer,
            0,
            bytemuck::cast_slice(&[camera_uniforms]),
        );
    }

    /// Render the camera preview to the window.
    fn render(
        &mut self,
        surface: SurfaceTexture,
        new_texture_value: Option<(&[u8], u32)>,
        width: u32,
        height: u32,
    ) {
        let surface_view = surface
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        // let surface_width = surface.texture.width();
        // let surface_height = surface.texture.height();

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &surface_view,
                    // depth_slice: None,
                    resolve_target: None, // Some(&surface_view),
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

            // Get or reinitialize the texture if necessary
            let (texture, _, bind_group) = &*self.texture.get_or_init((width, height), || {
                let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("Camera Texture"),
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

                let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Texture Bind Group"),
                    layout: &self.bind_group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&texture_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Sampler(&self.sampler),
                        },
                    ],
                });

                (texture, texture_view, bind_group)
            });

            if let Some((buffer, stride)) = new_texture_value {
                self.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    buffer,
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
            }

            render_pass.set_pipeline(&self.render_pipeline);
            render_pass.set_bind_group(0, bind_group, &[]);
            render_pass.set_bind_group(1, &self.uniform_bind_group, &[]);
            render_pass.draw(0..6, 0..1);
        }

        self.queue.submit(Some(encoder.finish()));
        surface.present();
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

pub struct CameraWindows {
    windows: HashMap<String, flume::Receiver<()>>,
}

impl CameraWindows {
    pub fn register(&self, window: WebviewWindow) {
        // self.windows.insert(
        //     window.label(),
        //     tokio::spawn(async move {
        //         // TODO
        //     }),
        // );

        // tokio::spawn(async move {});

        // window.on_window_event(|event| {
        //     match event {
        //         tauri::WindowEvent::Resized(size) => {
        //             // TODO
        //         }
        //         tauri::WindowEvent::Destroyed => {
        //             // TODO
        //         }
        //         _ => {}
        //     }
        // });

        todo!();
    }

    pub fn set_feed(&self, window: WebviewWindow) {
        todo!();
    }
}
