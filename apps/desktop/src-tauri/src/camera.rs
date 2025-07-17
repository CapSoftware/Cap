use std::sync::{Arc, Mutex, PoisonError, RwLock};

use anyhow::Context;
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
pub struct CameraWindowState {
    size: CameraPreviewSize,
    shape: CameraPreviewShape,
    mirrored: bool,
}

pub struct CameraWindowStateStore(Arc<Store<Wry>>);

impl CameraWindowStateStore {
    pub fn init(manager: &impl Manager<Wry>) -> tauri_plugin_store::Result<Self> {
        Ok(Self(
            tauri_plugin_store::StoreBuilder::new(manager, "cameraPreview").build()?,
        ))
    }

    pub fn save(&self, state: &CameraWindowState) -> tauri_plugin_store::Result<()> {
        self.0.set("state", serde_json::to_value(&state)?);
        self.0.save()
    }

    pub fn get(&self) -> Option<CameraWindowState> {
        self.0
            .get("state")
            .and_then(|v| serde_json::from_value(v).ok())
    }
}

pub struct CameraPreview {
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
    store: CameraWindowStateStore,
}

impl CameraPreview {
    // TODO: This isn't as efficient as it could be, but it's probably good enough for now.
    pub fn frame_sync_task() -> (
        flume::Sender<RawCameraFrame>,
        Arc<RwLock<Option<RawCameraFrame>>>,
    ) {
        let (camera_tx, camera_rx) = flume::bounded::<RawCameraFrame>(4);
        let frame = Arc::new(RwLock::new(None));
        let result = (camera_tx, frame.clone());

        tokio::spawn(async move {
            while let Ok(f) = camera_rx.recv_async().await {
                *frame.write().unwrap_or_else(PoisonError::into_inner) = Some(f);
            }
        });

        result
    }

    pub async fn init(window: WebviewWindow, size: PhysicalSize<u32>) -> anyhow::Result<Self> {
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

        let store = CameraWindowStateStore::init(&window)
            .with_context(|| "Failed to initialize camera window state store")?;

        Ok(Self {
            surface,
            surface_config: Mutex::new(config),
            render_pipeline,
            device,
            queue,
            sampler,
            bind_group_layout: texture_bind_group_layout,
            uniform_buffer,
            uniform_bind_group,
            store,
            window,
        })
    }

    // Called with the size of the video feed.
    //
    // This should be called when:
    //  - Video feed changes size
    //  - Window configuration changes
    pub fn resize(&self, width: u32, height: u32) -> tauri::Result<()> {
        let state = self.store.get().unwrap_or_default();

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

        // This will implicitly trigger `Self::reconfigure`
        self.window
            .set_size(LogicalSize::new(window_width, window_height))?;
        self.window.set_position(LogicalPosition::new(x, y))?;

        Ok(())
    }

    // Called by the Tauri window resize events on the main event loop to reconfigure the GPU texture and uniforms.
    //
    // We do this in the event-loop (as opposed to `resize`) so we don't need to lock the surface.
    pub fn reconfigure(&self, width: u32, height: u32) {
        let mut s = self
            .surface_config
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let state = self.store.get().unwrap_or_default();

        // Update surface
        s.width = if width > 0 { width } else { 1 };
        s.height = if height > 0 { height } else { 1 };
        self.surface.configure(&self.device, &s);

        // Update uniforms
        self.queue.write_buffer(
            &self.uniform_buffer,
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
}

// State that is only accessibly by `CameraPreview::render`.
// This allows it to be mutable.
pub struct CameraPreviewRenderer {
    scaler: scaling::Context,
    camera_frame: Arc<RwLock<Option<RawCameraFrame>>>,
}

impl CameraPreviewRenderer {
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
        })
    }

    pub fn render(&mut self, preview: &CameraPreview) -> Result<(), anyhow::Error> {
        let surface_frame = preview
            .surface
            .get_current_texture()
            .with_context(|| "Error getting surface current texture")?;
        let view = surface_frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = preview
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
            if let Some(frame) = self
                .camera_frame
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .as_ref()
            {
                let surface_config = preview
                    .surface_config
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);

                // Rescale the frame to the correct output size
                let (buffer, stride) = {
                    // This will either reuse or reinialise the scaler
                    self.scaler.cached(
                        frame.frame.format(),
                        frame.frame.width(),
                        frame.frame.height(),
                        format::Pixel::RGBA,
                        surface_config.width,
                        surface_config.height,
                        scaling::Flags::empty(),
                    );

                    // TODO: We could probably reuse this frame but if the resolution changes it needs to get reset.
                    let mut out_frame = frame::Video::empty();
                    self.scaler
                        .run(&frame.frame, &mut out_frame)
                        .with_context(|| "Error rescaling frame with ffmpeg")?;

                    (out_frame.data(0).to_vec(), out_frame.stride(0) as u32)
                };

                let texture = preview.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("Camera Texture"),
                    size: wgpu::Extent3d {
                        width: surface_config.width,
                        height: surface_config.height,
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

                let bind_group = preview
                    .device
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("Texture Bind Group"),
                        layout: &preview.bind_group_layout,
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(&texture_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::Sampler(&preview.sampler),
                            },
                        ],
                    });

                preview.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    &buffer,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(stride),
                        rows_per_image: Some(surface_config.height),
                    },
                    wgpu::Extent3d {
                        width: surface_config.width,
                        height: surface_config.height,
                        depth_or_array_layers: 1,
                    },
                );

                render_pass.set_pipeline(&preview.render_pipeline);
                render_pass.set_bind_group(0, &bind_group, &[]);
                render_pass.set_bind_group(1, &preview.uniform_bind_group, &[]);
                render_pass.draw(0..6, 0..1);
            }
        }

        preview.queue.submit(Some(encoder.finish()));
        surface_frame.present();

        Ok(())
    }
}
