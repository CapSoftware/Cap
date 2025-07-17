use std::{
    borrow::Cow,
    sync::{Arc, Mutex, PoisonError, RwLock},
};

use ffmpeg::{
    format::{self, Pixel},
    frame,
    software::scaling,
};

use cap_media::feeds::RawCameraFrame;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{LogicalSize, Manager, WebviewWindow, Wry};
use tauri_plugin_store::Store;
use tokio::sync::oneshot;
use wgpu::CompositeAlphaMode;

// If you change this you might also need to update the constant in `camera.tsx`
static BAR_HEIGHT: f32 = 56.0;

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
    pub fn init(manager: &impl Manager<Wry>) -> Self {
        Self(
            tauri_plugin_store::StoreBuilder::new(manager, "cameraPreview")
                .build()
                .unwrap(),
        )
    }

    pub fn save(&self, state: &CameraWindowState) -> tauri_plugin_store::Result<()> {
        self.0.set("state", serde_json::to_value(&state).unwrap());
        self.0.save()
    }

    pub fn get(&self) -> Option<CameraWindowState> {
        self.0
            .get("state")
            .map(|v| serde_json::from_value(v).unwrap())
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
    window: tauri::WebviewWindow<Wry>,
    store: CameraWindowStateStore,
    render_lock: Mutex<()>, // Add render lock to prevent race conditions
}

impl CameraPreview {
    // TODO: This isn't very efficient, but it's probaly good enough for now.
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

    pub async fn init(window: WebviewWindow) -> Self {
        let size = window.inner_size().unwrap();

        // Ensure we have a valid size, fallback to 460x460 if needed
        let width = if size.width > 0 { size.width } else { 460 };
        let height = if size.height > 0 { size.height } else { 460 };

        println!(
            "WINDOW SIZE DEBUG {:?} -> using ({}, {})",
            size, width, height
        );

        let (tx, rx) = oneshot::channel();
        window
            .run_on_main_thread({
                let window = window.clone();
                move || {
                    let instance = wgpu::Instance::default();
                    let surface = instance.create_surface(window.clone()).unwrap();
                    tx.send((instance, surface)).ok();
                }
            })
            .unwrap();

        let (instance, surface) = rx.await.unwrap();

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::default(),
                force_fallback_adapter: false,
                compatible_surface: Some(&surface),
            })
            .await
            .expect("Failed to find an appropriate adapter");

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
            .expect("Failed to create device");

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: None,
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(
                r#"
struct VertexOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOut {
    var pos = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), // bottom left
        vec2<f32>( 1.0, -1.0), // bottom right
        vec2<f32>(-1.0,  1.0), // top left
        vec2<f32>(-1.0,  1.0), // top left
        vec2<f32>( 1.0, -1.0), // bottom right
        vec2<f32>( 1.0,  1.0), // top right
    );
    var uv = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0),
    );
    var out: VertexOut;
    out.position = vec4<f32>(pos[idx], 0.0, 1.0);
    out.uv = uv[idx];
    return out;
}

@group(0) @binding(0)
var t_camera: texture_2d<f32>;
@group(0) @binding(1)
var s_camera: sampler;

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    return textureSample(t_camera, s_camera, in.uv);
}
"#,
            )),
        });

        // Create a bind group layout for our texture
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

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&texture_bind_group_layout],
            push_constant_ranges: &[],
        });

        let swapchain_capabilities = surface.get_capabilities(&adapter);
        let swapchain_format = swapchain_capabilities.formats[0];

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
                    blend: None, // No alpha blending
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
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: CompositeAlphaMode::Opaque, // TODO: Fix this???
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

        Self {
            surface,
            surface_config: Mutex::new(config),
            render_pipeline,
            device,
            queue,
            sampler,
            bind_group_layout: texture_bind_group_layout,
            store: CameraWindowStateStore::init(&window),
            window,
            render_lock: Mutex::new(()), // Initialize the render lock
        }
    }

    pub fn reconfigure(&self, width: u32, height: u32) {
        // Acquire the render lock to prevent any rendering during reconfiguration
        let _render_guard = self.render_lock.lock().unwrap();
        
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
        };
        let total_height = window_height + BAR_HEIGHT;

        let size = self.window.outer_size().unwrap();
        let monitor = self.window.current_monitor().unwrap().unwrap();
        let width =
            (size.width as f64 / monitor.scale_factor() - window_height as f64 - 100.0) as u32;
        let height =
            (size.height as f64 / monitor.scale_factor() - total_height as f64 - 100.0) as u32;

        self.window
            .set_size(LogicalSize::new(width, height))
            .unwrap();
        // TODO: Reposition the window

        let mut c = self.surface_config.lock().unwrap();
        c.width = width; // if width > 0 { width } else { 1 };
        c.height = height; // if height > 0 { height } else { 1 };

        println!(
            "RECONFIGURE WINDOW SIZE DEBUG using ({}, {})",
            c.width, c.height
        );

        self.surface.configure(&self.device, &c);
    }
}

// State that is only accessibly by `CameraPreview::render`.
// This allows it to be mutable.
pub struct CameraPreviewRenderer {
    // The rescaler so the camera feed can be scaled to the window.
    scaler: scaling::Context,
    // A frame used for the rescaler output.
    // Avoids needing to realloc a new one each time.
    rescaler_frame: frame::Video,
    // Frame from the camera capture
    camera_frame: Arc<RwLock<Option<RawCameraFrame>>>,
}

impl CameraPreviewRenderer {
    pub fn init(camera_frame: Arc<RwLock<Option<RawCameraFrame>>>) -> Self {
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
        )
        .unwrap();

        Self {
            scaler,
            rescaler_frame: frame::Video::empty(),
            camera_frame,
        }
    }

    pub fn render(&mut self, preview: &CameraPreview) {
        // Try to acquire the render lock, skip rendering if reconfiguration is happening
        let _render_guard = match preview.render_lock.try_lock() {
            Ok(guard) => guard,
            Err(_) => {
                // Reconfiguration is happening, skip this frame
                return;
            }
        };
        
        let surface_frame = preview
            .surface
            .get_current_texture()
            .expect("Failed to acquire next swap chain texture");
        let view = surface_frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = preview
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });

        if let Some(frame) = self
            .camera_frame
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            let surface_config = preview.surface_config.lock().unwrap();

            // Rescale the frame to the correct output size
            let buffer = {
                // This will either reuse or reinialise the scaler
                self.scaler.cached(
                    frame.frame.format(),
                    frame.frame.width(),
                    frame.frame.height(),
                    format::Pixel::RGBA,
                    surface_config.height,
                    surface_config.width,
                    scaling::Flags::empty(),
                );

                self.scaler
                    .run(&frame.frame, &mut self.rescaler_frame)
                    .unwrap();

                self.rescaler_frame.data(0).to_vec()
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
                    bytes_per_row: Some(surface_config.width * 4),
                    rows_per_image: Some(surface_config.height),
                },
                wgpu::Extent3d {
                    width: surface_config.width,
                    height: surface_config.height,
                    depth_or_array_layers: 1,
                },
            );

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
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            render_pass.set_pipeline(&preview.render_pipeline);
            render_pass.set_bind_group(0, &bind_group, &[]);
            render_pass.draw(0..6, 0..1);
        }

        preview.queue.submit(Some(encoder.finish()));
        surface_frame.present();
    }
}
