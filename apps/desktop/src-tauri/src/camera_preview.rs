use std::{
    borrow::Cow,
    sync::{Arc, Mutex, PoisonError, RwLock},
};

use ffmpeg::{format::Pixel, software::scaling::Context as ScalingContext};

use cap_media::feeds::RawCameraFrame;
use tauri::{Manager, WebviewWindow};
use tokio::sync::oneshot;

// Disable camera fails for testing
fn disable_camera_fails() {
    #[cfg(debug_assertions)]
    {
        cap_fail::set_fail("media::feeds::camera::init", false);
        cap_fail::set_fail("media::feeds::camera::switch_cameras", false);
        cap_fail::set_fail("media::feeds::camera::run panic", false);
        eprintln!("Camera preview: Disabled camera fails for testing");
    }
}

struct TextureResources {
    texture: wgpu::Texture,
    texture_view: wgpu::TextureView,
    bind_group: wgpu::BindGroup,
    rgb_buffer: Vec<u8>,
    dimensions: (u32, u32),
}

pub struct CameraPreview {
    surface: wgpu::Surface<'static>,
    surface_config: Mutex<wgpu::SurfaceConfiguration>,
    render_pipeline: wgpu::RenderPipeline,
    device: wgpu::Device,
    queue: wgpu::Queue,
    sampler: wgpu::Sampler,
    bind_group_layout: wgpu::BindGroupLayout,

    // Resources that can be modified during rendering
    // TODO: Can these use a `RwLock` or share a mutex?
    texture_resources: Arc<Mutex<TextureResources>>,
    last_dimensions: Mutex<(u32, u32)>,
    last_format: Mutex<Option<Pixel>>,
    frame: Arc<RwLock<Option<RawCameraFrame>>>,
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
        // Disable camera fails for testing
        disable_camera_fails();
        
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
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) tex_coord: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    
    // Create a proper full-screen quad using two triangles
    // Vertex positions for a full-screen quad
    let positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),  // bottom-left
        vec2<f32>( 1.0, -1.0),  // bottom-right
        vec2<f32>(-1.0,  1.0),  // top-left
        vec2<f32>(-1.0,  1.0),  // top-left
        vec2<f32>( 1.0, -1.0),  // bottom-right
        vec2<f32>( 1.0,  1.0)   // top-right
    );
    
    // Texture coordinates (flip Y to match OpenGL convention)
    let tex_coords = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 1.0),  // bottom-left
        vec2<f32>(1.0, 1.0),  // bottom-right
        vec2<f32>(0.0, 0.0),  // top-left
        vec2<f32>(0.0, 0.0),  // top-left
        vec2<f32>(1.0, 1.0),  // bottom-right
        vec2<f32>(1.0, 0.0)   // top-right
    );
    
    out.position = vec4<f32>(positions[in_vertex_index], 0.0, 1.0);
    out.tex_coord = tex_coords[in_vertex_index];
    
    return out;
}

@group(0) @binding(0)
var t_diffuse: texture_2d<f32>;
@group(0) @binding(1)
var s_diffuse: sampler;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(t_diffuse, s_diffuse, in.tex_coord);
    // Ensure we're getting some color output for debugging
    return color;
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

        // Load FFmpeg
        ffmpeg::init().expect("Failed to initialize FFmpeg");

        // Create a default texture to render with a test pattern
        let texture_size = wgpu::Extent3d {
            width: 640, // Default size, will be updated with actual frame size
            height: 480,
            depth_or_array_layers: 1,
        };

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Camera Texture"),
            size: texture_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Texture Bind Group"),
            layout: &texture_bind_group_layout,
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

        // Create a test pattern for the default texture
        let mut test_pattern = Vec::new();
        for y in 0..480 {
            for x in 0..640 {
                // Create a more visible test pattern with bright colors
                let r = if x < 320 { 255 } else { 0 };
                let g = if y < 240 { 255 } else { 0 };
                let b = if (x + y) % 100 < 50 { 255 } else { 0 };
                let a = 255u8;
                test_pattern.extend_from_slice(&[r, g, b, a]);
            }
        }

        eprintln!("Camera preview: Created initial test pattern with {} bytes", test_pattern.len());

        let texture_resources = Arc::new(Mutex::new(TextureResources {
            texture,
            texture_view,
            bind_group,
            rgb_buffer: test_pattern,
            dimensions: (640, 480),
        }));

        // Upload the initial test pattern to the texture
        let initial_texture = texture_resources.lock().unwrap().texture.clone();
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &initial_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &texture_resources.lock().unwrap().rgb_buffer,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(640 * 4),
                rows_per_image: Some(480),
            },
            wgpu::Extent3d {
                width: 640,
                height: 480,
                depth_or_array_layers: 1,
            },
        );

        eprintln!("Camera preview: Uploaded initial test pattern to texture");

        let frame = window
            .state::<Arc<tokio::sync::RwLock<crate::App>>>()
            .read()
            .await
            .camera_frame
            .clone();

        Self {
            surface,
            surface_config: Mutex::new(config),
            render_pipeline,
            device,
            queue,
            sampler,
            bind_group_layout: texture_bind_group_layout,
            texture_resources,
            last_dimensions: Mutex::new((0, 0)),
            last_format: Mutex::new(None),
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
        let surface_frame = self
            .surface
            .get_current_texture()
            .expect("Failed to acquire next swap chain texture");
        let view = surface_frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });

        // Check if we have a new camera frame to render
        if let Some(camera_frame) = self
            .frame
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            eprintln!("Camera preview: Received camera frame");
            let ff_video = &camera_frame.frame;

            // Get frame info using the safer FFVideo API
            let ptr;
            let width;
            let height;
            let format;

            unsafe {
                ptr = ff_video.as_ptr();
            }

            unsafe {
                width = (*ptr).width as u32;
                height = (*ptr).height as u32;
                // Get format using a safe fallback approach
                format =
                // Map common formats, fallback to RGB24 for unknown formats
                match (*ptr).format {
                    0 => Pixel::YUV420P,
                    1 => Pixel::YUYV422,
                    2 => Pixel::RGB24,
                    3 => Pixel::BGR24,
                    4 => Pixel::YUV422P,
                    5 => Pixel::YUV444P,
                    8 => Pixel::GRAY8,
                    13 => Pixel::YUVJ420P,
                    24 => Pixel::RGBA,
                    // Default to RGB24 for any other format
                    _ => Pixel::RGB24,
                }
            }

            eprintln!("Camera preview: Frame dimensions: {}x{}, format: {:?}", width, height, format);

            // Fallback to RGB24 if we get an unusual format
            let format = if format == Pixel::None {
                Pixel::RGB24
            } else {
                format
            };

            // Only process if we have valid dimensions
            if width > 0 && height > 0 {
                // Check if dimensions or format changed
                let mut dimensions = self.last_dimensions.lock().unwrap();
                let mut last_format = self.last_format.lock().unwrap();
                let mut texture_res = self.texture_resources.lock().unwrap();

                let format_changed = match *last_format {
                    Some(last_fmt) => last_fmt != format,
                    None => true,
                };

                if dimensions.0 != width || dimensions.1 != height || format_changed {
                    // Update format tracking
                    *last_format = Some(format);

                    // Update dimensions
                    *dimensions = (width, height);
                    texture_res.dimensions = (width, height);

                    // Resize buffer
                    texture_res
                        .rgb_buffer
                        .resize((width * height * 4) as usize, 0);

                    // Recreate texture with new dimensions
                    let texture_size = wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    };

                    let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                        label: Some("Camera Texture"),
                        size: texture_size,
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                        view_formats: &[],
                    });

                    let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

                    // Update texture binding
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

                    // Update texture resources
                    texture_res.texture = texture;
                    texture_res.texture_view = texture_view;
                    texture_res.bind_group = bind_group;
                }

                // Try to convert the frame using FFmpeg
                let result = || -> Result<Vec<u8>, ffmpeg::Error> {
                    // Create destination frame
                    let mut dest_frame = ffmpeg::frame::Video::new(Pixel::RGBA, width, height);

                    // Create a scaler on-demand
                    let mut scaler = ScalingContext::get(
                        format,      // source format
                        width,       // source width
                        height,      // source height
                        Pixel::RGBA, // destination format
                        width,       // destination width
                        height,      // destination height
                        ffmpeg::software::scaling::flag::Flags::BILINEAR,
                    )?;

                    // Create a new frame from the raw frame data
                    let mut source_frame = ffmpeg::frame::Video::empty();
                    unsafe {
                        // Copy the frame pointer data for conversion
                        ffmpeg::ffi::av_frame_ref(source_frame.as_mut_ptr(), ff_video.as_ptr());
                    }

                    // Convert the frame
                    scaler.run(&source_frame, &mut dest_frame)?;

                    // Create a new buffer with the converted data
                    let dest_data = dest_frame.data(0);
                    let output = dest_data.to_vec();

                    Ok(output)
                };

                // Execute the conversion
                match result() {
                    Ok(output_buffer) => {
                        // Ensure our buffer is the right size
                        let expected_size = (width * height * 4) as usize;
                        if output_buffer.len() == expected_size {
                            // Store the buffer for future use
                            texture_res.rgb_buffer = output_buffer;

                            // Calculate bytes per row
                            let bytes_per_row = width * 4; // RGBA format (4 bytes per pixel)

                            eprintln!("Camera preview: Uploading texture {}x{} with {} bytes", width, height, texture_res.rgb_buffer.len());

                            // Copy the pixel data to the GPU texture
                            self.queue.write_texture(
                                wgpu::TexelCopyTextureInfo {
                                    texture: &texture_res.texture,
                                    mip_level: 0,
                                    origin: wgpu::Origin3d::ZERO,
                                    aspect: wgpu::TextureAspect::All,
                                },
                                &texture_res.rgb_buffer,
                                wgpu::TexelCopyBufferLayout {
                                    offset: 0,
                                    bytes_per_row: Some(bytes_per_row),
                                    rows_per_image: Some(height),
                                },
                                wgpu::Extent3d {
                                    width,
                                    height,
                                    depth_or_array_layers: 1,
                                },
                            );
                        } else {
                            eprintln!("Camera preview: Buffer size mismatch. Expected: {}, Got: {}", expected_size, output_buffer.len());
                            // If conversion failed, create a test pattern
                            let mut test_pattern = Vec::new();
                            for y in 0..height {
                                for x in 0..width {
                                    // Create a more visible test pattern with bright colors
                                    let r = if x < width / 2 { 255 } else { 0 };
                                    let g = if y < height / 2 { 255 } else { 0 };
                                    let b = if (x + y) % 100 < 50 { 255 } else { 0 };
                                    let a = 255u8;
                                    test_pattern.extend_from_slice(&[r, g, b, a]);
                                }
                            }
                            texture_res.rgb_buffer = test_pattern;

                            // Copy the test pattern to the GPU texture
                            let bytes_per_row = width * 4;
                            eprintln!("Camera preview: Uploading test pattern {}x{} with {} bytes", width, height, texture_res.rgb_buffer.len());
                            self.queue.write_texture(
                                wgpu::TexelCopyTextureInfo {
                                    texture: &texture_res.texture,
                                    mip_level: 0,
                                    origin: wgpu::Origin3d::ZERO,
                                    aspect: wgpu::TextureAspect::All,
                                },
                                &texture_res.rgb_buffer,
                                wgpu::TexelCopyBufferLayout {
                                    offset: 0,
                                    bytes_per_row: Some(bytes_per_row),
                                    rows_per_image: Some(height),
                                },
                                wgpu::Extent3d {
                                    width,
                                    height,
                                    depth_or_array_layers: 1,
                                },
                            );
                        }
                    }
                    Err(e) => {
                        eprintln!("Camera preview: Frame conversion failed: {:?}", e);
                        // If conversion failed, create a test pattern
                        let mut test_pattern = Vec::new();
                        for y in 0..height {
                            for x in 0..width {
                                // Create a more visible test pattern with bright colors
                                let r = if x < width / 2 { 255 } else { 0 };
                                let g = if y < height / 2 { 255 } else { 0 };
                                let b = if (x + y) % 100 < 50 { 255 } else { 0 };
                                let a = 255u8;
                                test_pattern.extend_from_slice(&[r, g, b, a]);
                            }
                        }
                        texture_res.rgb_buffer = test_pattern;

                        // Copy the test pattern to the GPU texture
                        let bytes_per_row = width * 4;
                        eprintln!("Camera preview: Uploading test pattern (conversion failed) {}x{} with {} bytes", width, height, texture_res.rgb_buffer.len());
                        self.queue.write_texture(
                            wgpu::TexelCopyTextureInfo {
                                texture: &texture_res.texture,
                                mip_level: 0,
                                origin: wgpu::Origin3d::ZERO,
                                aspect: wgpu::TextureAspect::All,
                            },
                            &texture_res.rgb_buffer,
                            wgpu::TexelCopyBufferLayout {
                                offset: 0,
                                bytes_per_row: Some(bytes_per_row),
                                rows_per_image: Some(height),
                            },
                            wgpu::Extent3d {
                                width,
                                height,
                                depth_or_array_layers: 1,
                            },
                        );
                    }
                }

                // We need to drop the lock before starting the render pass
                // Get a reference to the bind group
                let bind_group = &texture_res.bind_group;

                // Render the texture to the screen
                {
                    eprintln!("Camera preview: Starting render pass with camera frame");
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
                    render_pass.set_bind_group(0, bind_group, &[]);
                    render_pass.draw(0..6, 0..1); // Draw 6 vertices for 2 triangles
                }
            } else {
                // No valid frame dimensions, just render with default bind group
                let texture_res = self.texture_resources.lock().unwrap();
                let bind_group = &texture_res.bind_group;

                // Render with default texture
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

                eprintln!("Camera preview: Starting render pass with default texture (no valid dimensions)");
                render_pass.set_pipeline(&self.render_pipeline);
                render_pass.set_bind_group(0, bind_group, &[]);
                render_pass.draw(0..6, 0..1); // Draw 6 vertices for 2 triangles
            }
        } else {
            // No frame available, just render with default bind group
            eprintln!("Camera preview: No camera frame available");
            let texture_res = self.texture_resources.lock().unwrap();
            let bind_group = &texture_res.bind_group;

            // Render with default texture
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

            eprintln!("Camera preview: Starting render pass with default texture (no frame available)");
            render_pass.set_pipeline(&self.render_pipeline);
            render_pass.set_bind_group(0, bind_group, &[]);
            render_pass.draw(0..6, 0..1); // Draw 6 vertices for 2 triangles
        }

        self.queue.submit(Some(encoder.finish()));
        surface_frame.present();
        eprintln!("Camera preview: Submitted commands and presented frame");
    }
}
