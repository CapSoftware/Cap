use std::{
    sync::{Arc, Mutex, PoisonError, RwLock},
    thread,
};

use anyhow::{anyhow, Context};
use ffmpeg::{
    format::{self, Pixel},
    frame,
    software::scaling,
};

use cap_media::feeds::RawCameraFrame;
use flume::Receiver;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{LogicalPosition, LogicalSize, Manager, PhysicalSize, WebviewWindow, Wry};
use tauri_plugin_store::Store;
use tokio::sync::{oneshot, Notify};
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

// Cache values tied to the window output
struct WindowCache {
    // cache key
    width: u32,
    height: u32,

    // values
    texture: wgpu::Texture,
    texture_view: wgpu::TextureView,
    bind_group: wgpu::BindGroup,
}

impl WindowCache {
    pub fn check<'a>(
        this: &'a mut Option<Self>,
        device: &wgpu::Device,
        bind_group_layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        surface_width: u32,
        surface_height: u32,
    ) -> (&'a mut Self, bool) {
        // Will rerun when no cache, or when input changed
        let reinitialize = this.as_ref().map(|v| v.width) != Some(surface_width)
            || this.as_ref().map(|v| v.height) != Some(surface_height);

        if reinitialize {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
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
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });

            let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Texture Bind Group"),
                layout: &bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&texture_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&sampler),
                    },
                ],
            });

            *this = Some(WindowCache {
                width: surface_width,
                height: surface_height,
                texture,
                texture_view,
                bind_group,
            });
        }

        (this.as_mut().expect("initialized above"), reinitialize)
    }
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
            let mut last_frame_info = None;
            let mut resampler_output = None;
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
                let surface_frame = renderer.surface.get_current_texture().unwrap();
                // .with_context(|| "Error getting surface current texture")?;

                let surface_width = surface_frame.texture.width();
                let surface_height = surface_frame.texture.height();

                let (buffer, stride) = if let Some(frame) = frame {
                    let current_frame_info = Some((frame.format(), frame.width(), frame.height()));
                    if
                    // The incoming camera feed as changed size
                    last_frame_info != current_frame_info
                    // Or the state has changed (Eg. window shape)
                    || reconfigure
                    {
                        last_frame_info = current_frame_info;
                        resampler_output = None;

                        let state = get_state(&store).unwrap_or_default();
                        renderer
                            .resize_window(&state, frame.width(), frame.height())
                            .unwrap();

                        // TODO: Does this care about the incoming frame's resolution or is the cache key condition wrong?
                        renderer.update_uniforms(&state, frame.height());

                        if !window_visible {
                            window_visible = true;
                            renderer.window.show().unwrap();
                        }
                    };

                    let mut resampler_output = match resampler_output.as_mut() {
                        Some(frame) => frame,
                        None => {
                            resampler_output = Some(frame::Video::empty());
                            &mut resampler_output.as_mut().expect("assigned above")
                        }
                    };

                    // TODO: Investigate moving the rescaling into the GPU shader
                    scaler.cached(
                        frame.format(),
                        frame.width(),
                        frame.height(),
                        format::Pixel::RGBA,
                        surface_width,
                        surface_height,
                        scaling::Flags::empty(),
                    );

                    scaler.run(&frame, resampler_output).unwrap();
                    // .with_context(|| "Error rescaling frame with ffmpeg")?;

                    (
                        resampler_output.data(0).to_vec(),
                        resampler_output.stride(0) as u32,
                    )
                } else {
                    // If a frame is not available, we render a fallback block color.
                    // The frontend is responsible for displaying the loading text above this.
                    //
                    // We do it this way so the correct window shape is maintained without it being implemented in both the webview and shader.

                    let color = [0x11, 0x11, 0x11, 0xFF]; // #111111
                    let pixel_count = (surface_height * surface_width) as usize;
                    let buffer: Vec<u8> = color
                        .iter()
                        .cycle()
                        .take(pixel_count * 4)
                        .copied()
                        .collect();

                    (buffer, 4 * surface_width)
                };

                renderer.render(surface_frame, &buffer, stride, &*store);
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
    surface_config: Mutex<wgpu::SurfaceConfiguration>,
    render_pipeline: wgpu::RenderPipeline,
    device: wgpu::Device,
    queue: wgpu::Queue,
    sampler: wgpu::Sampler,
    bind_group_layout: wgpu::BindGroupLayout,
    uniform_buffer: wgpu::Buffer,
    uniform_bind_group: wgpu::BindGroup,
    window: tauri::WebviewWindow<Wry>,

    // TODO: Flatten this???
    window_cache: Option<WindowCache>,
}

impl Renderer {
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

        Ok(Self {
            surface,
            surface_config: Mutex::new(config),
            render_pipeline,
            device,
            queue,
            sampler,
            bind_group_layout,
            uniform_buffer,
            uniform_bind_group,
            window,

            window_cache: None,
        })
    }

    /// Resize the OS window to the correct size
    fn resize_window(
        &self,
        state: &CameraWindowState,
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

    // TODO
    fn update_uniforms(&self, state: &CameraWindowState, height: u32) {
        self.queue.write_buffer(
            &self.uniform_buffer,
            0,
            bytemuck::cast_slice(&[
                height as f32,
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

    fn render(
        &mut self,
        surface_frame: SurfaceTexture,
        buffer: &[u8],
        stride: u32,
        store: &Store<tauri::Wry>,
    ) {
        let surface_width = surface_frame.texture.width();
        let surface_height = surface_frame.texture.height();

        let view = surface_frame
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

            let (window_cache, intialized) = WindowCache::check(
                &mut self.window_cache,
                &self.device,
                &self.bind_group_layout,
                &self.sampler,
                // TODO: Should these be derived from the Tauri window's size instead?
                surface_width,
                surface_height,
            );
            if intialized {
                // let mut s = window
                //     .surface_config
                //     .lock()
                //     .unwrap_or_else(PoisonError::into_inner);
                // s.width = if width > 0 { width } else { 1 };
                // s.height = if height > 0 { height } else { 1 };
                // window.surface.configure(&window.device, &s);

                // update_uniforms(window, &s, &state);

                // TODO: `update_uniforms`
                {
                    let state: CameraWindowState = store
                        .get("state")
                        .and_then(|v| serde_json::from_value(v).ok())
                        .unwrap_or_default();

                    self.queue.write_buffer(
                        &self.uniform_buffer,
                        0,
                        bytemuck::cast_slice(&[
                            surface_height as f32,
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

                // TODO: We should reconfigure the GPU surface?
            }

            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &window_cache.texture,
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
            render_pass.set_bind_group(0, &window_cache.bind_group, &[]);
            render_pass.set_bind_group(1, &self.uniform_bind_group, &[]);
            render_pass.draw(0..6, 0..1);
        }

        self.queue.submit(Some(encoder.finish()));
        surface_frame.present();
    }
}

fn get_state(store: &Store<tauri::Wry>) -> Option<CameraWindowState> {
    store
        .get("state")
        .and_then(|v| serde_json::from_value(v).ok())
}
