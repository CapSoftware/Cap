use std::{
    sync::{Arc, PoisonError, RwLock},
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
use futures::executor::block_on;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{LogicalPosition, LogicalSize, Manager, PhysicalSize, WebviewWindow, Wry};
use tauri_plugin_store::Store;
use tokio::sync::{Notify, broadcast, oneshot};
use tracing::error;
use wgpu::{CompositeAlphaMode, SurfaceTexture};

static TOOLBAR_HEIGHT: f32 = 56.0 /* toolbar height (also defined in Typescript) */;

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
    reconfigure: (broadcast::Sender<()>, broadcast::Receiver<()>),
    loading: (broadcast::Sender<()>, broadcast::Receiver<()>),
    window: RwLock<Option<Arc<Notify>>>,
    store: Arc<Store<Wry>>,
    camera_rx: Receiver<RawCameraFrame>,
}

impl CameraPreview {
    pub fn init(
        manager: &impl Manager<Wry>,
        camera_rx: Receiver<RawCameraFrame>,
    ) -> tauri_plugin_store::Result<Self> {
        Ok(Self {
            reconfigure: broadcast::channel(1),
            loading: broadcast::channel(1),
            window: RwLock::new(None),
            store: tauri_plugin_store::StoreBuilder::new(manager, "cameraPreview").build()?,
            camera_rx,
        })
    }

    /// Initialize the state when the camera preview window is created.
    /// Currently we only support a single camera preview window at a time!
    pub async fn init_window(&self, window: WebviewWindow) -> anyhow::Result<()> {
        let mut renderer = Renderer::init(window.clone()).await?;

        let store = self.store.clone();
        let mut reconfigure = self.reconfigure.1.resubscribe();
        let camera_rx = self.camera_rx.clone();
        let loading_tx = self.loading.0.clone();
        let shutdown = Arc::new(Notify::new());
        let shutdown_handle = shutdown.clone();
        thread::spawn(move || {
            println!("NEW THREAD");

            let mut window_visible = false;
            let mut first = true;
            let mut loading = true;
            let mut resampler_frame = Cached::default();
            let mut aspect_ratio = Cached::default();
            let mut shutdown = std::pin::pin!(shutdown.notified());
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

            while let Some((frame, reconfigure)) = block_on({
                let shutdown = shutdown.as_mut();
                let camera_rx = &camera_rx;
                let reconfigure = &mut reconfigure;

                async {
                    // Triggers the first paint
                    if first {
                        // We don't set `first = false` as that is done within the loop.
                        return Some((None, true));
                    }

                    tokio::select! {
                        frame = camera_rx.recv_async() => frame.ok().map(|f| (Some(f.frame), false)),
                        _ = reconfigure.recv() =>  Some((None, true)),
                        _ = shutdown => None,
                    }
                }
            }) {
                let mut window_resize_required =
                    if first || reconfigure && renderer.refresh_state(&store) {
                        first = false;
                        renderer.update_state_uniforms();
                        true
                    } else if let Some(frame) = frame.as_ref()
                        && renderer.frame_info.update_key_and_should_init((
                            frame.format(),
                            frame.width(),
                            frame.height(),
                        ))
                    {
                        true
                    } else {
                        false
                    };

                let camera_aspect_ratio = *aspect_ratio.get_or_init(
                    (
                        frame.as_ref().map(|f| (f.width(), f.height())),
                        renderer.state.clone(),
                    ),
                    || {
                        let ratio = frame
                            .as_ref()
                            .map(|f| f.width() as f32 / f.height() as f32)
                            .unwrap_or(if renderer.state.shape == CameraPreviewShape::Full {
                                16.0 / 9.0
                            } else {
                                1.0
                            });
                        renderer.update_camera_aspect_ratio_uniforms(ratio);
                        window_resize_required = true;
                        ratio
                    },
                );

                if window_resize_required {
                    if let Err(err) =
                        renderer.update_window_size(frame.as_ref(), camera_aspect_ratio)
                    {
                        error!("Error updating window size: {err:?}");
                        continue;
                    }
                }

                if let Err(err) = renderer.reconfigure_gpu_surface() {
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
                        if loading == true {
                            println!("LOADING DONE");
                            loading_tx.send(()).ok();
                            loading = false;
                        }

                        let resampler_frame = resampler_frame
                            .get_or_init((output_width, output_height), || frame::Video::empty());

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
        });

        let mut state = self.window.write().unwrap_or_else(PoisonError::into_inner);
        if state.is_some() {
            return Err(anyhow!("Camera preview window already initialized"));
        }
        *state = Some(shutdown_handle);

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
            task.notify_waiters();
        }
    }

    /// Save the current state of the camera window.
    pub fn save(&self, state: &CameraWindowState) -> tauri_plugin_store::Result<()> {
        self.store.set("state", serde_json::to_value(&state)?);
        self.store.save()?;
        self.reconfigure.0.send(()).ok();
        Ok(())
    }

    /// Wait for the camera to load.
    pub async fn wait_for_camera_to_load(&self) {
        self.loading.1.resubscribe().recv().await.ok();
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
                        visibility: wgpu::ShaderStages::FRAGMENT,
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
            size: std::mem::size_of::<[f32; 5]>() as u64, // offset_pixels, shape, size, mirrored, padding
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let window_uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Window Uniform Buffer"),
            size: std::mem::size_of::<[f32; 3]>() as u64, // window_height, window_width, padding
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let camera_uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Camera Uniform Buffer"),
            size: std::mem::size_of::<[f32; 2]>() as u64, // camera_aspect_ratio, padding
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
    fn update_window_size(&self, frame: Option<&FFVideo>, aspect: f32) -> tauri::Result<()> {
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

        self.window
            .set_size(LogicalSize::new(window_width, window_height))?;
        self.window.set_position(LogicalPosition::new(x, y))?;

        Ok(())
    }

    /// Reconfigure the GPU surface if the window has changed size
    fn reconfigure_gpu_surface(&mut self) -> tauri::Result<()> {
        let size = self.window.outer_size()?;
        self.surface_size
            .get_or_init((size.width, size.height), || {
                println!(
                    "Reconfiguring GPU surface - Width: {}, Height: {}",
                    size.width, size.height
                );
                self.surface_config.width = if size.width > 0 { size.width } else { 1 };
                self.surface_config.height = if size.height > 0 { size.height } else { 1 };
                self.surface.configure(&self.device, &self.surface_config);

                self.queue.write_buffer(
                    &self.window_uniform_buffer,
                    0,
                    bytemuck::cast_slice(&[
                        self.surface_config.height as f32,
                        self.surface_config.width as f32,
                        0.0, // padding
                    ]),
                );
            });

        Ok(())
    }

    /// Update the uniforms which hold the camera preview state
    fn update_state_uniforms(&self) {
        self.queue.write_buffer(
            &self.uniform_buffer,
            0,
            bytemuck::cast_slice(&[
                TOOLBAR_HEIGHT,
                match self.state.shape {
                    CameraPreviewShape::Round => 0.0,
                    CameraPreviewShape::Square => 1.0,
                    CameraPreviewShape::Full => 2.0,
                },
                match self.state.size {
                    CameraPreviewSize::Sm => 0.0,
                    CameraPreviewSize::Lg => 1.0,
                },
                if self.state.mirrored { 1.0 } else { 0.0 },
                0.0, // padding
            ]),
        );
    }

    /// Update the uniforms which hold the camera aspect ratio
    fn update_camera_aspect_ratio_uniforms(&self, camera_aspect_ratio: f32) {
        self.queue.write_buffer(
            &self.camera_uniform_buffer,
            0,
            bytemuck::cast_slice(&[
                camera_aspect_ratio,
                0.0, // padding
            ]),
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
                    &buffer,
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
    pub fn get_or_init<'a>(&'a mut self, key: K, init: impl FnOnce() -> V) -> &'a mut V {
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
