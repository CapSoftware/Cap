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
use tauri::WebviewWindow;
use tokio::sync::oneshot;

pub struct CameraPreview {
    surface: wgpu::Surface<'static>,
    surface_config: Mutex<wgpu::SurfaceConfiguration>,
    render_pipeline: wgpu::RenderPipeline,
    device: wgpu::Device,
    queue: wgpu::Queue,
    sampler: wgpu::Sampler,
    bind_group_layout: wgpu::BindGroupLayout,
    uniform_buffer: wgpu::Buffer,
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

    pub async fn init(window: &WebviewWindow) -> Self {
        let size = window.inner_size().unwrap();

        println!("WINDOW SIZE DEBUG {:?}", size); // TODO

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
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) tex_coord: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    // Define a full-screen quad with proper texture coordinates
    var out: VertexOutput;

    // Create a full-screen quad using 6 vertices (2 triangles)
    // Vertex positions for a full-screen quad
    let positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),  // Bottom-left
        vec2<f32>( 1.0, -1.0),  // Bottom-right
        vec2<f32>(-1.0,  1.0),  // Top-left
        vec2<f32>(-1.0,  1.0),  // Top-left (duplicate)
        vec2<f32>( 1.0, -1.0),  // Bottom-right (duplicate)
        vec2<f32>( 1.0,  1.0)   // Top-right
    );

    // Texture coordinates for the quad
    let tex_coords = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 1.0),  // Bottom-left
        vec2<f32>(1.0, 1.0),  // Bottom-right
        vec2<f32>(0.0, 0.0),  // Top-left
        vec2<f32>(0.0, 0.0),  // Top-left (duplicate)
        vec2<f32>(1.0, 1.0),  // Bottom-right (duplicate)
        vec2<f32>(1.0, 0.0)   // Top-right
    );

    out.position = vec4<f32>(positions[in_vertex_index], 0.0, 1.0);
    out.tex_coord = tex_coords[in_vertex_index];

    return out;
}

@group(0) @binding(0)
var t_diffuse: texture_2d<f32>;
@group(0) @binding(1)
var s_diffuse: sampler;
@group(0) @binding(2)
var<uniform> aspect_ratio: f32;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Calculate coordinates relative to center (0.5, 0.5)
    let center = vec2<f32>(0.5, 0.5);
    let to_center = in.tex_coord - center;

    // Adjust the coordinates to account for aspect ratio
    // For a perfect circle, we need to normalize the coordinates
    // based on the aspect ratio of the window
    // Use a mathematical approach that works for both cases
    let adjusted_coords = vec2<f32>(
        to_center.x / max(aspect_ratio, 1.0),
        to_center.y * min(aspect_ratio, 1.0)
    );

    // Calculate distance from center (normalized)
    let dist = length(adjusted_coords * 2.0); // Multiplying by 2 makes radius 1.0 in normalized space

    // Circle mask with smooth edge
    let radius = 1.0;
    let edge_smoothness = 0.01;
    let circle_alpha = 1.0 - smoothstep(radius - edge_smoothness, radius, dist);

    // Return transparent for fragments outside the circle
    if (circle_alpha <= 0.0) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    // Sample texture and apply the circle mask
    let color = textureSample(t_diffuse, s_diffuse, in.tex_coord);
    return vec4<f32>(color.rgb, color.a * circle_alpha);
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
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
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

        // Find the best alpha mode for transparency
        let alpha_mode = if swapchain_capabilities
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::PreMultiplied)
        {
            wgpu::CompositeAlphaMode::PreMultiplied
        } else if swapchain_capabilities
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::PostMultiplied)
        {
            wgpu::CompositeAlphaMode::PostMultiplied
        } else {
            swapchain_capabilities.alpha_modes[0]
        };

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: swapchain_format,
            width: size.width,
            height: size.height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode,
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

        // Create uniform buffer for aspect ratio
        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Aspect Ratio Uniform Buffer"),
            size: std::mem::size_of::<f32>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Self {
            surface,
            surface_config: Mutex::new(config),
            render_pipeline,
            device,
            queue,
            sampler,
            bind_group_layout: texture_bind_group_layout,
            uniform_buffer,
        }
    }

    pub fn reconfigure(&self, width: u32, height: u32) {
        let mut c = self.surface_config.lock().unwrap();
        c.width = if width > 0 { width } else { 1 };
        c.height = if height > 0 { height } else { 1 };
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
            // TODO: This seems like a bottleneck
            let surface_config = preview.surface_config.lock().unwrap();

            // Rescale the frame to the correct output size
            let buffer = {
                // This will either reuse or reinialise the scaler
                self.scaler.cached(
                    frame.frame.format(),
                    frame.frame.width(),
                    frame.frame.height(),
                    format::Pixel::RGBA, // frame.frame.format(),
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

            // Calculate aspect ratio to make a perfect circle
            // We need to normalize the coordinates based on the window's aspect ratio
            let aspect_ratio = surface_config.width as f32 / surface_config.height as f32;

            // Update uniform buffer with aspect ratio
            preview.queue.write_buffer(
                &preview.uniform_buffer,
                0,
                bytemuck::cast_slice(&[aspect_ratio]),
            );

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
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer: &preview.uniform_buffer,
                                offset: 0,
                                size: None,
                            }),
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
                        load: wgpu::LoadOp::Load,
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
