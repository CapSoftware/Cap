use std::{
    sync::{Arc, Mutex, PoisonError, RwLock},
    thread,
};

use anyhow::{Context, anyhow};
use ffmpeg::{
    format::{self, Pixel},
    frame,
    software::scaling,
};

use cap_media::{data::FFVideo, feeds::RawCameraFrame};
use flume::Receiver;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{LogicalPosition, LogicalSize, Manager, PhysicalSize, WebviewWindow, Wry};
use tauri_plugin_store::Store;
use tokio::sync::{Notify, oneshot};
use tracing::error;
use wgpu::{CompositeAlphaMode, SurfaceTexture};

static TOOLBAR_HEIGHT: f32 = 56.0 /* toolbar height (also defined in Typescript) */ + 16.0 /* camera preview inset */;

#[derive(Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CameraPreviewSize {
    #[default]
    Sm,
    Lg,
}

#[derive(Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CameraPreviewShape {
    #[default]
    Round,
    Square,
    Full,
}

#[derive(Debug, Default, Serialize, Deserialize, Type)]
pub struct CameraWindowState {
    size: CameraPreviewSize,
    shape: CameraPreviewShape,
    mirrored: bool,
}

pub struct CameraPreview {
    reconfigure: Arc<Notify>,
    window: RwLock<Option<tokio::task::JoinHandle<()>>>,
    store: Arc<Store<Wry>>,
    camera_rx: Receiver<RawCameraFrame>,
}

impl CameraPreview {
    pub fn init(
        manager: &impl Manager<Wry>,
        camera_rx: Receiver<RawCameraFrame>,
    ) -> tauri_plugin_store::Result<Self> {
        Ok(Self {
            reconfigure: Arc::new(Notify::new()),
            window: RwLock::new(None),
            store: tauri_plugin_store::StoreBuilder::new(manager, "cameraPreview").build()?,
            camera_rx,
        })
    }

    /// Initialize the state when the camera preview window is created.
    /// Currently we only support a single camera preview window at a time!
    pub async fn init_window(&self, window: WebviewWindow) -> anyhow::Result<()> {
        let mut renderer = Renderer::init(window.clone()).await?;

        // Due to the ffmpeg rescaler not being `Send` and joining the channels requiring async, we split it out.
        let (internal_tx, mut internal_rx) = tokio::sync::mpsc::channel(4);
        let reconfigure = self.reconfigure.clone();
        let camera_rx = self.camera_rx.clone();

        let task = tokio::spawn(async move {
            let reconfigure = reconfigure.notified();
            let mut reconfigure = std::pin::pin!(reconfigure);
            let mut last_frame = None;

            // Render a loading frame by default
            internal_tx.send((None, true)).await.ok();

            loop {
                let frame = tokio::select! {
                    frame = camera_rx.recv_async() => frame.map(Some),
                    _ = reconfigure.as_mut() => Ok(None),
                };

                let result = match frame {
                    Ok(Some(frame)) => {
                        last_frame = Some(frame.frame.clone());
                        (Some(frame.frame), false)
                    }
                    // By yielding a new frame when reconfigure is sent,
                    // the renderer thread will rescale the output to the new window size.
                    // If no frame is available, the fallback frame will be regenerated to the new size
                    Ok(None) => (last_frame.clone(), true),
                    Err(err) => {
                        error!("Error receiving frame from camera: {err}");
                        return;
                    }
                };

                if let Err(_) = internal_tx.send(result).await {
                    error!("Error sending frame to renderer. Did it crash?");
                    return;
                }
            }
        });

        let store = self.store.clone();
        thread::spawn(move || {
            let mut window_visible = false;
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

            // This thread will automatically be shutdown if `internal_tx` is dropped
            // which is held by the Tokio task.
            while let Some((frame, reconfigure)) = internal_rx.blocking_recv() {
                if reconfigure {
                    renderer.refresh_state(&store);
                }

                renderer.reconfigure_gpu_surface().unwrap();

                if let Ok(surface) = renderer
                    .surface
                    .get_current_texture()
                    .map_err(|err| error!("Error getting camera renderer surface texture: {err:?}"))
                {
                    let window_size_updated = renderer
                        .update_window_size(reconfigure, &frame)
                        .map_err(|err| error!("Error updating window size: {err:?}"))
                        .unwrap_or_default();
                    renderer.update_uniforms(reconfigure || window_size_updated, &surface);

                    let (buffer, stride) = if let Some(frame) = frame {
                        let resampler_frame = resampler_frame.get_or_init(
                            (surface.texture.width(), surface.texture.height()),
                            || frame::Video::empty(),
                        );

                        scaler.cached(
                            frame.format(),
                            frame.width(),
                            frame.height(),
                            format::Pixel::RGBA,
                            surface.texture.width(),
                            surface.texture.height(),
                            scaling::Flags::empty(),
                        );

                        if let Err(err) = scaler.run(&frame, resampler_frame) {
                            error!("Error rescaling frame with ffmpeg: {err:?}");
                            continue;
                        }

                        (
                            resampler_frame.data(0).to_vec(),
                            resampler_frame.stride(0) as u32,
                        )
                    } else {
                        render_solid_frame(
                            [0x11, 0x11, 0x11, 0xFF], // #111111
                            surface.texture.width(),
                            surface.texture.height(),
                        )
                    };

                    renderer.render(surface, &buffer, stride);
                }

                if !window_visible {
                    window_visible = true;
                    if let Err(err) = renderer.window.show() {
                        error!("Failed to show camera preview window: {}", err);
                    }
                }
            }
        });

        let mut state = self.window.write().unwrap_or_else(PoisonError::into_inner);
        if state.is_some() {
            return Err(anyhow!("Camera preview window already initialized"));
        }
        *state = Some(task);

        Ok(())
    }

    /// Triggered by Tauri when the camera preview window is closed.
    /// We drop the handle we have to the `tauri::Window` + wgpu stuff, to prevent us attempting to accessing something that's no longer valid.
    pub fn close_window(&self) {
        if let Some(task) = self
            .window
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            task.abort();
        }
    }

    /// Save the current state of the camera window.
    pub fn save(&self, state: &CameraWindowState) -> tauri_plugin_store::Result<()> {
        self.store.set("state", serde_json::to_value(&state)?);
        self.store.save()?;
        self.reconfigure.notify_waiters();
        Ok(())
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
    uniform_bind_group: wgpu::BindGroup,
    window: tauri::WebviewWindow<Wry>,

    // Allows all methods to easily access the current state
    // This will be updated when the `reconfigure` notify is triggered
    cached_state: CameraWindowState,
    // Used by `Self::update_window_size` to determine if the window should resize.
    // The window size is derived from the camera's resolution so this tracks when that changes.
    cached_frame_info: Option<(format::Pixel, u32, u32)>,
    // Used by `Self::update_uniforms` to determine if it should update
    cache_surface_height: Option<u32>,
    cache_surface_size: Cached<(u32, u32)>,
    // Used by `Self::render` to cache the texture across renders
    cached_texture: Cached<(u32, u32), (wgpu::Texture, wgpu::TextureView, wgpu::BindGroup)>,
}

impl Renderer {
    /// Initialize a new renderer for a specific Tauri window.
    async fn init(window: WebviewWindow) -> anyhow::Result<Self> {
        let size = window
            .inner_size()
            .with_context(|| "Error getting the window size")?;

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
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
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
            size: std::mem::size_of::<[f32; 6]>() as u64, // window_height, offset_pixels, shape, size, mirrored, padding
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Uniform Bind Group"),
            layout: &uniform_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
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
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let surface_config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: swapchain_format,
            width: size.width,
            height: size.height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: CompositeAlphaMode::PostMultiplied,
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

        Ok(Self {
            surface,
            surface_config,
            render_pipeline,
            device,
            queue,
            sampler,
            bind_group_layout,
            uniform_buffer,
            uniform_bind_group,
            window,

            cached_state: CameraWindowState::default(),
            cached_frame_info: None,
            cache_surface_height: None,
            cache_surface_size: Cached::default(),
            cached_texture: Cached::default(),
        })
    }

    /// Update the local cache of the camera state
    fn refresh_state(&mut self, store: &Store<tauri::Wry>) {
        self.cached_state = store
            .get("state")
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
    }

    /// Resize the OS window to the correct size if required
    fn update_window_size(
        &mut self,
        reconfigure: bool,
        frame: &Option<FFVideo>,
    ) -> tauri::Result<bool> {
        let should_resize = if reconfigure {
            // If the `state` changes we should resize so the new shape.
            true
        } else if let Some(frame) = frame
            && self.cached_frame_info != Some((frame.format(), frame.width(), frame.height()))
        {
            // If the incoming frame's resolution changes.
            self.cached_frame_info = Some((frame.format(), frame.width(), frame.height()));
            true
        } else {
            false
        };

        if should_resize {
            let base: f32 = if self.cached_state.size == CameraPreviewSize::Sm {
                230.0
            } else {
                400.0
            };
            let aspect = frame
                .as_ref()
                .map(|f| f.width() as f32 / f.height() as f32)
                .unwrap_or(1.0);
            let window_width = if self.cached_state.shape == CameraPreviewShape::Full {
                if aspect >= 1.0 { base * aspect } else { base }
            } else {
                base
            };
            let window_height = if self.cached_state.shape == CameraPreviewShape::Full {
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
                (monitor.size().clone(), size, monitor.scale_factor())
            } else {
                (PhysicalSize::new(640, 360), LogicalPosition::new(0, 0), 1.0)
            };

            let x = (monitor_size.width as f64 / monitor_scale_factor - window_width as f64 - 100.0)
                as u32
                + monitor_offset.x;
            let y = (monitor_size.height as f64 / monitor_scale_factor
                - window_height as f64
                - 100.0) as u32
                + monitor_offset.y;

            self.window
                .set_size(LogicalSize::new(window_width, window_height))?;
            self.window.set_position(LogicalPosition::new(x, y))?;
        }

        Ok(should_resize)
    }

    fn reconfigure_gpu_surface(&mut self) -> tauri::Result<()> {
        let size = self.window.outer_size()?;
        self.cache_surface_size
            .get_or_init((size.width, size.height), || {
                self.surface_config.width = if size.width > 0 { size.width } else { 1 };
                self.surface_config.height = if size.height > 0 { size.height } else { 1 };
                self.surface.configure(&self.device, &self.surface_config);
            });

        Ok(())
    }

    // Update the shader state if required
    fn update_uniforms(&mut self, reconfigure: bool, surface: &SurfaceTexture) {
        if reconfigure || self.cache_surface_height != Some(surface.texture.height()) {
            self.cache_surface_height = Some(surface.texture.height());
            self.queue.write_buffer(
                &self.uniform_buffer,
                0,
                bytemuck::cast_slice(&[
                    surface.texture.height() as f32,
                    TOOLBAR_HEIGHT,
                    match self.cached_state.shape {
                        CameraPreviewShape::Round => 0.0,
                        CameraPreviewShape::Square => 1.0,
                        CameraPreviewShape::Full => 2.0,
                    },
                    match self.cached_state.size {
                        CameraPreviewSize::Sm => 0.0,
                        CameraPreviewSize::Lg => 1.0,
                    },
                    if self.cached_state.mirrored { 1.0 } else { 0.0 },
                    0.0, // padding
                ]),
            );
        }
    }

    /// Render the camera preview to the window.
    fn render(&mut self, surface: SurfaceTexture, buffer: &[u8], stride: u32) {
        let surface_width = surface.texture.width();
        let surface_height = surface.texture.height();

        let view = surface
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
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

            // Get or reinitialize the texture if necessary
            let (texture, _, bind_group) =
                &*self
                    .cached_texture
                    .get_or_init((surface_width, surface_height), || {
                        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                            label: Some("Camera Texture"),
                            size: wgpu::Extent3d {
                                width: surface_width,
                                height: surface_height,
                                depth_or_array_layers: 1,
                            },
                            mip_level_count: 1,
                            sample_count: 1,
                            dimension: wgpu::TextureDimension::D2,
                            format: wgpu::TextureFormat::Rgba8Unorm,
                            usage: wgpu::TextureUsages::TEXTURE_BINDING
                                | wgpu::TextureUsages::COPY_DST,
                            view_formats: &[],
                        });

                        let texture_view =
                            texture.create_view(&wgpu::TextureViewDescriptor::default());

                        let bind_group =
                            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
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

            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &buffer,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride),
                    rows_per_image: Some(surface_height),
                },
                wgpu::Extent3d {
                    width: surface_width,
                    height: surface_height,
                    depth_or_array_layers: 1,
                },
            );

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
    pub fn get_or_init<'a>(&'a mut self, key: K, init: impl FnOnce() -> V) -> &'a mut V {
        if self.value.as_ref().is_none_or(|(k, _)| *k != key) {
            self.value = Some((key, init()));
        }

        &mut self.value.as_mut().expect("checked above").1
    }
}
