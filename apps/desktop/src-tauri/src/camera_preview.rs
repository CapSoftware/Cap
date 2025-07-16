use std::{
    borrow::Cow,
    sync::{Arc, Mutex, PoisonError, RwLock},
    thread,
};

use cap_media::feeds::{CameraFeed, RawCameraFrame};
use tauri::{Manager, WebviewWindow};
use tokio::sync::{mpsc, oneshot};

pub struct CameraPreview {
    surface: wgpu::Surface<'static>,
    surface_config: Mutex<wgpu::SurfaceConfiguration>,
    render_pipeline: wgpu::RenderPipeline,
    device: wgpu::Device,
    queue: wgpu::Queue,
    frame: Arc<RwLock<Option<RawCameraFrame>>>,
}

impl CameraPreview {
    pub async fn init(window: &WebviewWindow) -> Self {
        let size = window.inner_size().unwrap();

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

        // Create the logical device and command queue
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: None,
                required_features: wgpu::Features::empty(),
                // Make sure we use the texture resolution limits from the adapter, so we can support images the size of the swapchain.
                required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                    .using_resolution(adapter.limits()),
                memory_hints: Default::default(),
                trace: wgpu::Trace::Off,
            })
            .await
            .expect("Failed to create device");

        // Load the shaders from disk
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: None,
            source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(
                r#"
@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> @builtin(position) vec4<f32> {
let x = f32(i32(in_vertex_index) - 1);
let y = f32(i32(in_vertex_index & 1u) * 2 - 1);
return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
"#,
            )),
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[],
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
                targets: &[Some(swapchain_format.into())],
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
            alpha_mode: swapchain_capabilities.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };

        surface.configure(&device, &config);

        let app = window.state::<Arc<tokio::sync::RwLock<crate::App>>>();
        let frame = Arc::new(RwLock::new(None));

        thread::spawn({
            let frame = frame.clone();
            let camera_feed_rx = app.read().await.camera_feed_rx.clone().unwrap();
            move || {
                while let Ok(f) = camera_feed_rx.recv() {
                    println!("GOT FRAME");
                    frame
                        .write()
                        .unwrap_or_else(PoisonError::into_inner)
                        .replace(f);
                }
            }
        });

        Self {
            surface,
            surface_config: Mutex::new(config),
            render_pipeline,
            device,
            queue,
            frame,
        }
    }

    pub fn reconfigure(&self, width: u32, height: u32) {
        let mut c = self.surface_config.lock().unwrap();
        c.width = if width > 0 { width } else { 1 };
        c.height = if height > 0 { height } else { 1 };
        self.surface.configure(&self.device, &c);
    }

    pub fn render(&self) {
        let frame = self
            .surface
            .get_current_texture()
            .expect("Failed to acquire next swap chain texture");
        let view = frame
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
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            render_pass.set_pipeline(&self.render_pipeline);
            render_pass.draw(0..3, 0..1);
        }

        if let Some(frame) = self
            .frame
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            println!("FRAME READY!"); // TODO
        }

        self.queue.submit(Some(encoder.finish()));
        frame.present();
    }
}
