use std::sync::{Arc, Mutex, PoisonError, RwLock, TryLockError};

use anyhow::{anyhow, Context};
use ffmpeg::{
    format::{self, Pixel},
    frame,
    software::scaling,
};

use cap_media::feeds::RawCameraFrame;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{LogicalPosition, LogicalSize, Manager, PhysicalSize, WebviewWindow, Wry};
use tauri_plugin_store::Store;
use tokio::sync::oneshot;
use wgpu::CompositeAlphaMode;

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
pub struct CameraWindowConfig {
    size: CameraPreviewSize,
    shape: CameraPreviewShape,
    mirrored: bool,
}

pub struct CameraPreviewMutableState {
    scaler: scaling::Context,
    camera_frame: Arc<RwLock<Option<RawCameraFrame>>>,
    cached_texture: Option<CachedTexture>,
}

impl CameraPreviewMutableState {
    pub fn init(camera_frame: Arc<RwLock<Option<RawCameraFrame>>>) -> Result<Self, ffmpeg::Error> {
        // We initialize a scaler with bogus frame information.
        // We use `Context.cache` later which will reinitialize the scaler with the correct frame information.
        let scaler = scaling::Context::get(
            Pixel::RGBA,
            1,
            1,
            Pixel::RGBA,
            1,
            1,
            scaling::Flags::empty(),
        )?;

        Ok(Self {
            scaler,
            camera_frame,
            cached_texture: None,
        })
    }

    pub fn invalidate_texture_cache(&mut self) {
        self.cached_texture = None;
    }
}

struct CachedTexture {
    texture: wgpu::Texture,
    texture_view: wgpu::TextureView,
    bind_group: wgpu::BindGroup,
    width: u32,
    height: u32,
}

struct WindowState {
    surface: wgpu::Surface<'static>,
    surface_config: Mutex<wgpu::SurfaceConfiguration>,
    render_pipeline: wgpu::RenderPipeline,
    device: wgpu::Device,
    queue: wgpu::Queue,
    sampler: wgpu::Sampler,
    bind_group_layout: wgpu::BindGroupLayout,
    uniform_buffer: wgpu::Buffer,
    uniform_bind_group: wgpu::BindGroup,
    window: tauri::WebviewWindow<Wry>,
}

// Application-level state for the camera preview.
// We don't can't put it on `App` due to that requiring async to get a mutex lock on it (which isn't possible within `on_window_event`).
pub struct CameraWindowState {
    window: Arc<RwLock<Option<WindowState>>>,
    store: Arc<Store<Wry>>,
    pub frame: Arc<RwLock<Option<RawCameraFrame>>>,
}

impl CameraWindowState {
    /// Initialize the global state for the managing the camera preview.
    pub fn init(
        manager: &impl Manager<Wry>,
        frame: Arc<RwLock<Option<RawCameraFrame>>>,
    ) -> tauri_plugin_store::Result<Self> {
        Ok(Self {
            window: Arc::new(RwLock::new(None)),
            store: tauri_plugin_store::StoreBuilder::new(manager, "cameraPreview").build()?,
            frame,
        })
    }

    /// Initialize the state when the camera preview window is created.
    /// Currently we only support a single camera preview window at a time!
    pub async fn init_window(&self, window: WebviewWindow) -> anyhow::Result<()> {
        let size = window
            .inner_size()
            .with_context(|| "Error getting the window size")?;

        // Reset frame data so we don't show a stale frame while loading
        self.frame
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .take();

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

        let texture_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
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
            bind_group_layouts: &[&texture_bind_group_layout, &uniform_bind_group_layout],
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

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: swapchain_format,
            width: size.width,
            height: size.height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: CompositeAlphaMode::PostMultiplied,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };

        surface.configure(&device, &config);

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let window = WindowState {
            surface,
            surface_config: Mutex::new(config),
            render_pipeline,
            device,
            queue,
            sampler,
            bind_group_layout: texture_bind_group_layout,
            uniform_buffer,
            uniform_bind_group,
            window,
        };

        {
            let s = window
                .surface_config
                .lock()
                .unwrap_or_else(PoisonError::into_inner);

            let state = self.get().unwrap_or_default();
            self.resize_inner(&window, &state, s.width, s.height)?;
            update_uniforms(&window, &s, &state);
            window.window.show()?;
        }

        let mut state = self.window.write().unwrap_or_else(PoisonError::into_inner);
        // We bail out really late which kinda sucks but:
        //  - it shouldn't happen
        //  - we can't hold the mutex over the wgpu `await` so we wouldn't be able to enforce it anyway.
        if state.is_some() {
            return Err(anyhow!("Camera preview window already initialized"));
        }
        *state = Some(window);

        Ok(())
    }

    /// Triggered by Tauri when the camera preview window is closed.
    /// We drop the handle we have to the `tauri::Window` + wgpu stuff, to prevent us attempting to accessing something that's no longer valid.
    pub fn close_window(&self) {
        self.window
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }

    /// Save the current state of the camera window.
    pub fn save(&self, state: &CameraWindowConfig) -> tauri_plugin_store::Result<()> {
        self.store.set("state", serde_json::to_value(&state)?);
        self.store.save()?;

        if let Some(window) = self
            .window
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            let s = window
                .surface_config
                .lock()
                .unwrap_or_else(PoisonError::into_inner);

            self.resize_inner(window, &self.get().unwrap_or_default(), s.width, s.height)?;
            update_uniforms(window, &s, state);
        }
        Ok(())
    }

    /// Get the current state of the camera window.
    /// Get the current state of the camera window.
    pub fn get(&self) -> Option<CameraWindowConfig> {
        self.store
            .get("state")
            .and_then(|v| serde_json::from_value(v).ok())
    }

    /// Called to update the preview based on the new size of the video feed.
    pub fn resize(&self, width: u32, height: u32) -> tauri::Result<()> {
        if let Some(window) = self
            .window
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            self.resize_inner(window, &self.get().unwrap_or_default(), width, height)?;
        }
        Ok(())
    }

    fn resize_inner(
        &self,
        window: &WindowState,
        state: &CameraWindowConfig,
        width: u32,
        height: u32,
    ) -> tauri::Result<()> {
        let base: f32 = if state.size == CameraPreviewSize::Sm {
            230.0
        } else {
            400.0
        };
        let aspect = width as f32 / height as f32;
        let window_width = if state.shape == CameraPreviewShape::Full {
            if aspect >= 1.0 {
                base * aspect
            } else {
                base
            }
        } else {
            base
        };
        let window_height = if state.shape == CameraPreviewShape::Full {
            if aspect >= 1.0 {
                base
            } else {
                base / aspect
            }
        } else {
            base
        } + TOOLBAR_HEIGHT;

        let (monitor_size, monitor_offset, monitor_scale_factor): (
            PhysicalSize<u32>,
            LogicalPosition<u32>,
            _,
        ) = if let Some(monitor) = window.window.current_monitor()? {
            let size = monitor.position().to_logical(monitor.scale_factor());
            (monitor.size().clone(), size, monitor.scale_factor())
        } else {
            (PhysicalSize::new(640, 360), LogicalPosition::new(0, 0), 1.0)
        };

        let x = (monitor_size.width as f64 / monitor_scale_factor - window_width as f64 - 100.0)
            as u32
            + monitor_offset.x;
        let y = (monitor_size.height as f64 / monitor_scale_factor - window_height as f64 - 100.0)
            as u32
            + monitor_offset.y;

        window
            .window
            .set_size(LogicalSize::new(window_width, window_height))?;
        window.window.set_position(LogicalPosition::new(x, y))?;

        Ok(())
    }

    /// Called by the Tauri event loop on window resize events to reconfigure the GPU texture and uniforms.
    ///
    /// We do this in the event-loop (as opposed to `resize`) so we don't need to lock the surface.
    pub fn on_window_resize(
        &self,
        width: u32,
        height: u32,
        mutable_state: &mut CameraPreviewMutableState,
    ) {
        let state = self.get().unwrap_or_default();
        if let Some(window) = self
            .window
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            let mut s = window
                .surface_config
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            s.width = if width > 0 { width } else { 1 };
            s.height = if height > 0 { height } else { 1 };
            window.surface.configure(&window.device, &s);

            // Invalidate cached texture on window resize
            mutable_state.invalidate_texture_cache();

            update_uniforms(window, &s, &state);
        }
    }

    /// Called by the Tauri event loop to render the camera preview.
    pub fn render(&self, state: &mut CameraPreviewMutableState) -> Result<(), anyhow::Error> {
        if let Some(window) = self
            .window
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            let surface_frame = window
                .surface
                .get_current_texture()
                .with_context(|| "Error getting surface current texture")?;
            let view = surface_frame
                .texture
                .create_view(&wgpu::TextureViewDescriptor::default());
            let mut encoder = window
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

                // if no frame is available the render pass will clear the window
                if let Some(frame) = state
                    .camera_frame
                    .read()
                    .unwrap_or_else(PoisonError::into_inner)
                    .as_ref()
                {
                    let surface_width = surface_frame.texture.width();
                    let surface_height = surface_frame.texture.height();

                    // Rescale the frame to the correct output size
                    let (buffer, stride) = {
                        // This will either reuse or reinialise the scaler
                        state.scaler.cached(
                            frame.frame.format(),
                            frame.frame.width(),
                            frame.frame.height(),
                            format::Pixel::RGBA,
                            surface_width,
                            surface_height,
                            scaling::Flags::empty(),
                        );

                        let mut out_frame = frame::Video::empty();
                        state
                            .scaler
                            .run(&frame.frame, &mut out_frame)
                            .with_context(|| "Error rescaling frame with ffmpeg")?;

                        (out_frame.data(0).to_vec(), out_frame.stride(0) as u32)
                    };

                    let should_create_new = match state.cached_texture.as_ref() {
                        Some(cached_tex) => {
                            cached_tex.width != surface_width || cached_tex.height != surface_height
                        }
                        None => true,
                    };

                    if should_create_new {
                        println!("SHOULD CREATE NEW TEXTURE1");

                        let texture = window.device.create_texture(&wgpu::TextureDescriptor {
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
                            window.device.create_bind_group(&wgpu::BindGroupDescriptor {
                                label: Some("Texture Bind Group"),
                                layout: &window.bind_group_layout,
                                entries: &[
                                    wgpu::BindGroupEntry {
                                        binding: 0,
                                        resource: wgpu::BindingResource::TextureView(&texture_view),
                                    },
                                    wgpu::BindGroupEntry {
                                        binding: 1,
                                        resource: wgpu::BindingResource::Sampler(&window.sampler),
                                    },
                                ],
                            });

                        state.cached_texture = Some(CachedTexture {
                            texture,
                            texture_view,
                            bind_group,
                            width: surface_width,
                            height: surface_height,
                        });
                    }

                    let cached_tex = state.cached_texture.as_ref().unwrap();

                    window.queue.write_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture: &cached_tex.texture,
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

                    render_pass.set_pipeline(&window.render_pipeline);
                    render_pass.set_bind_group(0, &cached_tex.bind_group, &[]);
                    render_pass.set_bind_group(1, &window.uniform_bind_group, &[]);
                    render_pass.draw(0..6, 0..1);
                } else {
                    let surface_width = surface_frame.texture.width();
                    let surface_height = surface_frame.texture.height();

                    let should_create_new = match state.cached_texture.as_ref() {
                        Some(cached_tex) => {
                            cached_tex.width != surface_width || cached_tex.height != surface_height
                        }
                        None => true,
                    };

                    if should_create_new {
                        println!("SHOULD CREATE NEW TEXTURE1");

                        let texture = window.device.create_texture(&wgpu::TextureDescriptor {
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
                            window.device.create_bind_group(&wgpu::BindGroupDescriptor {
                                label: Some("Texture Bind Group"),
                                layout: &window.bind_group_layout,
                                entries: &[
                                    wgpu::BindGroupEntry {
                                        binding: 0,
                                        resource: wgpu::BindingResource::TextureView(&texture_view),
                                    },
                                    wgpu::BindGroupEntry {
                                        binding: 1,
                                        resource: wgpu::BindingResource::Sampler(&window.sampler),
                                    },
                                ],
                            });

                        state.cached_texture = Some(CachedTexture {
                            texture,
                            texture_view,
                            bind_group,
                            width: surface_width,
                            height: surface_height,
                        });
                    }

                    let cached_tex = state.cached_texture.as_ref().unwrap();

                    // Create color data for #111111 (RGBA format)
                    let color = [0x11, 0x11, 0x11, 0xFF]; // R=17, G=17, B=17, A=255
                    let pixel_count = (surface_height * surface_width) as usize;
                    let buffer: Vec<u8> = color
                        .iter()
                        .cycle()
                        .take(pixel_count * 4)
                        .copied()
                        .collect();

                    window.queue.write_texture(
                        wgpu::TexelCopyTextureInfo {
                            texture: &cached_tex.texture,
                            mip_level: 0,
                            origin: wgpu::Origin3d::ZERO,
                            aspect: wgpu::TextureAspect::All,
                        },
                        &buffer,
                        wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(4 * surface_width),
                            rows_per_image: Some(surface_height),
                        },
                        wgpu::Extent3d {
                            width: surface_width,
                            height: surface_height,
                            depth_or_array_layers: 1,
                        },
                    );

                    render_pass.set_pipeline(&window.render_pipeline);
                    render_pass.set_bind_group(0, &cached_tex.bind_group, &[]);
                    render_pass.set_bind_group(1, &window.uniform_bind_group, &[]);
                    render_pass.draw(0..6, 0..1);
                };
            }

            window.queue.submit(Some(encoder.finish()));
            surface_frame.present();
        }

        Ok(())
    }
}

// TODO: This isn't as efficient as it could be, but it's probably good enough for now.
pub fn camera_frame_sync_task() -> (
    flume::Sender<RawCameraFrame>,
    Arc<RwLock<Option<RawCameraFrame>>>,
) {
    let (camera_tx, camera_rx) = flume::bounded::<RawCameraFrame>(2); // TODO: Make this 4???
    let frame = Arc::new(RwLock::new(None));
    let result = (camera_tx, frame.clone());

    tokio::spawn(async move {
        while let Ok(f) = camera_rx.recv_async().await {
            let mut lock = match frame.try_write() {
                Ok(v) => v,
                Err(TryLockError::Poisoned(v)) => v.into_inner(),
                // We don't lock to try and reduce lag
                Err(TryLockError::WouldBlock) => continue,
            };

            *lock = Some(f);
        }
    });

    result
}

fn update_uniforms(
    window: &WindowState,
    s: &wgpu::SurfaceConfiguration,
    state: &CameraWindowConfig,
) {
    window.queue.write_buffer(
        &window.uniform_buffer,
        0,
        bytemuck::cast_slice(&[
            s.height as f32,
            TOOLBAR_HEIGHT,
            match state.shape {
                CameraPreviewShape::Round => 0.0,
                CameraPreviewShape::Square => 1.0,
                CameraPreviewShape::Full => 2.0,
            },
            match state.size {
                CameraPreviewSize::Sm => 0.0,
                CameraPreviewSize::Lg => 1.0,
            },
            if state.mirrored { 1.0 } else { 0.0 },
            0.0, // padding
        ]),
    );
}
