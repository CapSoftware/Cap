use bytemuck::{Pod, Zeroable};
use image::{ImageBuffer, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::PathBuf;
use wgpu::util::DeviceExt;
use wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;

use crate::utils::ffmpeg_path_as_str;

use std::io::Read;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RenderOptions {
    pub screen_recording_path: PathBuf,
    pub webcam_recording_path: PathBuf,
    pub webcam_size: (u32, u32),
    pub webcam_position: (f32, f32),
    pub webcam_style: WebcamStyle,
    pub output_size: (u32, u32),
    pub background: Background,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WebcamStyle {
    pub border_radius: f32,
    pub shadow_color: [f32; 4],
    pub shadow_blur: f32,
    pub shadow_offset: (f32, f32),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, Pod, Zeroable)]
#[repr(C)]
pub struct CompositeParams {
    webcam_position: [f32; 2],
    webcam_size: [f32; 2],
    output_size: [f32; 2],
    border_radius: f32,
    shadow_color: [f32; 4],
    shadow_blur: f32,
    shadow_offset: [f32; 2],
    background_start: [f32; 4],
    background_end: [f32; 4],
    background_angle: f32,
    _padding: [f32; 9],
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum Background {
    Color([f32; 4]),
    Gradient {
        start: [f32; 4],
        end: [f32; 4],
        angle: f32,
    },
}

pub async fn render_video(options: RenderOptions) -> Result<PathBuf, Box<dyn std::error::Error>> {
    println!("Initializing wgpu...");

    println!(
        "Size of CompositeParams: {} bytes",
        std::mem::size_of::<CompositeParams>()
    );

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::default());
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .unwrap();
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor::default(), None)
        .await?;

    println!("Creating output texture...");
    let texture_size = wgpu::Extent3d {
        width: options.output_size.0,
        height: options.output_size.1,
        depth_or_array_layers: 1,
    };
    let output_texture = device.create_texture(
        &(wgpu::TextureDescriptor {
            size: texture_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            label: Some("output_texture"),
            view_formats: &[],
        }),
    );
    let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());

    println!("Creating shader module...");
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Shader"),
        source: wgpu::ShaderSource::Wgsl(include_str!("shaders/composite.wgsl").into()),
    });

    println!("Creating bind group layout and pipeline...");
    let bind_group_layout = device.create_bind_group_layout(
        &(wgpu::BindGroupLayoutDescriptor {
            label: Some("Bind Group Layout"),
            entries: &[
                // Screen texture
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
                // Screen sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                // Webcam texture
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                // Webcam sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                // Uniform buffer
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        }),
    );

    let pipeline_layout = device.create_pipeline_layout(
        &(wgpu::PipelineLayoutDescriptor {
            label: Some("Render Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        }),
    );

    let compilation_options = wgpu::PipelineCompilationOptions {
        constants: &HashMap::new(),
        zero_initialize_workgroup_memory: false,
        vertex_pulling_transform: false,
    };

    let render_pipeline = device.create_render_pipeline(
        &(wgpu::RenderPipelineDescriptor {
            label: Some("Render Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_main",
                buffers: &[],
                compilation_options: compilation_options.clone(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_main",
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options,
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: Some(wgpu::Face::Back),
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState {
                count: 1,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            multiview: None,
            cache: None,
        }),
    );

    println!("Creating uniform buffer...");
    let (background_start, background_end, background_angle) = match options.background {
        Background::Color(color) => (color, color, 0.0),
        Background::Gradient { start, end, angle } => (start, end, angle),
    };

    let uniform_data = CompositeParams {
        webcam_position: options.webcam_position.into(),
        webcam_size: (options.webcam_size.0 as f32, options.webcam_size.1 as f32).into(),
        output_size: (options.output_size.0 as f32, options.output_size.1 as f32).into(),
        border_radius: options.webcam_style.border_radius,
        shadow_color: options.webcam_style.shadow_color,
        shadow_blur: options.webcam_style.shadow_blur,
        shadow_offset: options.webcam_style.shadow_offset.into(),
        background_start,
        background_end,
        background_angle,
        _padding: [0.0; 9],
    };

    let uniform_buffer = device.create_buffer_init(
        &(wgpu::util::BufferInitDescriptor {
            label: Some("Uniform Buffer"),
            contents: bytemuck::cast_slice(&[uniform_data]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        }),
    );

    println!("Setting up FFmpeg input for screen recording...");
    let ffmpeg_binary_path_str = ffmpeg_path_as_str().unwrap().to_owned();
    let mut screen_command = Command::new(&ffmpeg_binary_path_str);
    screen_command
        .args(&[
            "-i",
            options.screen_recording_path.to_str().unwrap(),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            &format!("{}x{}", options.output_size.0, options.output_size.1),
            "-c:v",
            "rawvideo",
            "-frames:v",
            "1",
            "pipe:1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    println!("Setting up FFmpeg input for webcam recording...");
    let mut webcam_command = Command::new(&ffmpeg_binary_path_str);
    webcam_command
        .args(&[
            "-i",
            options.webcam_recording_path.to_str().unwrap(),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            &format!("{}x{}", options.webcam_size.0, options.webcam_size.1),
            "-c:v",
            "rawvideo",
            "-frames:v",
            "1",
            "pipe:1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    println!("Reading video frames...");
    let screen_frame_size = (options.output_size.0 * options.output_size.1 * 4) as usize;
    let webcam_frame_size = (options.webcam_size.0 * options.webcam_size.1 * 4) as usize;

    let mut screen_frame = vec![0u8; screen_frame_size];
    let mut webcam_frame = vec![0u8; webcam_frame_size];

    let mut screen_output = screen_command
        .spawn()
        .expect("Failed to spawn screen FFmpeg process");
    let mut webcam_output = webcam_command
        .spawn()
        .expect("Failed to spawn webcam FFmpeg process");

    screen_output
        .stdout
        .as_mut()
        .unwrap()
        .read_exact(&mut screen_frame)
        .expect("Failed to read screen frame data");
    webcam_output
        .stdout
        .as_mut()
        .unwrap()
        .read_exact(&mut webcam_frame)
        .expect("Failed to read webcam frame data");

    println!("Screen frame size: {}", screen_frame.len());
    println!("Webcam frame size: {}", webcam_frame.len());

    // Save screen frame as PNG
    let screen_frame_path = PathBuf::from(
        "/Users/richie/Library/Application Support/so.cap.desktop-solid/recordings/ac2909e0-2f5e-45ff-95e3-8efb50a56a12.cap/output/screen_frame.png"
    );
    let screen_image: RgbaImage = ImageBuffer::from_raw(
        options.output_size.0,
        options.output_size.1,
        screen_frame.clone(),
    )
    .expect("Failed to create screen image buffer");
    screen_image.save(&screen_frame_path)?;
    println!("Saved screen frame to {:?}", screen_frame_path);

    // Save webcam frame as PNG
    let webcam_frame_path = PathBuf::from(
        "/Users/richie/Library/Application Support/so.cap.desktop-solid/recordings/ac2909e0-2f5e-45ff-95e3-8efb50a56a12.cap/output/webcam_frame.png"
    );
    let webcam_image: RgbaImage = ImageBuffer::from_raw(
        options.webcam_size.0,
        options.webcam_size.1,
        webcam_frame.clone(),
    )
    .expect("Failed to create webcam image buffer");
    webcam_image.save(&webcam_frame_path)?;
    println!("Saved webcam frame to {:?}", webcam_frame_path);

    println!("Uploading textures...");
    let screen_texture = device.create_texture_with_data(
        &queue,
        &(wgpu::TextureDescriptor {
            size: wgpu::Extent3d {
                width: options.output_size.0,
                height: options.output_size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            label: Some("screen_texture"),
            view_formats: &[],
        }),
        wgpu::util::TextureDataOrder::LayerMajor,
        &screen_frame,
    );

    let webcam_texture = device.create_texture_with_data(
        &queue,
        &(wgpu::TextureDescriptor {
            size: wgpu::Extent3d {
                width: options.webcam_size.0,
                height: options.webcam_size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            label: Some("webcam_texture"),
            view_formats: &[],
        }),
        wgpu::util::TextureDataOrder::LayerMajor,
        &webcam_frame,
    );

    let screen_view = screen_texture.create_view(&wgpu::TextureViewDescriptor::default());
    let webcam_view = webcam_texture.create_view(&wgpu::TextureViewDescriptor::default());

    println!("Creating bind group...");
    let bind_group = device.create_bind_group(
        &(wgpu::BindGroupDescriptor {
            layout: &bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&screen_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(
                        &device.create_sampler(&wgpu::SamplerDescriptor::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&webcam_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(
                        &device.create_sampler(&wgpu::SamplerDescriptor::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: uniform_buffer.as_entire_binding(),
                },
            ],
            label: Some("Bind Group"),
        }),
    );

    println!("Starting render pass...");
    let mut encoder = device.create_command_encoder(
        &(wgpu::CommandEncoderDescriptor {
            label: Some("Render Encoder"),
        }),
    );

    {
        let mut render_pass = encoder.begin_render_pass(
            &(wgpu::RenderPassDescriptor {
                label: Some("Render Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &output_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            }),
        );

        render_pass.set_pipeline(&render_pipeline);
        render_pass.set_bind_group(0, &bind_group, &[]);
        render_pass.draw(0..3, 0..1);
    }

    queue.submit(std::iter::once(encoder.finish()));

    println!("Reading the output texture...");
    let width = options.output_size.0;
    let height = options.output_size.1;

    // Calculate the aligned bytes per row
    let align = COPY_BYTES_PER_ROW_ALIGNMENT as u32;
    let unpadded_bytes_per_row = width * 4;
    let padding = (align - (unpadded_bytes_per_row % align)) % align;
    let padded_bytes_per_row = unpadded_bytes_per_row + padding;

    let buffer_size = (padded_bytes_per_row * height) as u64;
    let buffer = device.create_buffer(
        &(wgpu::BufferDescriptor {
            size: buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            label: Some("Output Buffer"),
            mapped_at_creation: false,
        }),
    );

    let mut encoder = device.create_command_encoder(
        &(wgpu::CommandEncoderDescriptor {
            label: Some("Copy Encoder"),
        }),
    );

    encoder.copy_texture_to_buffer(
        wgpu::ImageCopyTexture {
            texture: &output_texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::ImageCopyBuffer {
            buffer: &buffer,
            layout: wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(padded_bytes_per_row),
                rows_per_image: Some(height),
            },
        },
        texture_size,
    );

    queue.submit(std::iter::once(encoder.finish()));

    println!("Mapping the buffer...");
    let buffer_slice = buffer.slice(..);
    let (tx, rx) = tokio::sync::oneshot::channel();
    buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
        tx.send(result).unwrap();
    });
    device.poll(wgpu::Maintain::Wait);
    rx.await.unwrap()?;

    let data = buffer_slice.get_mapped_range();

    println!("Converting data to image...");
    let padded_data = data.to_vec();
    let mut image_data = Vec::with_capacity((width * height * 4) as usize);
    for chunk in padded_data.chunks(padded_bytes_per_row as usize) {
        image_data.extend_from_slice(&chunk[..unpadded_bytes_per_row as usize]);
    }
    let image_buffer: ImageBuffer<Rgba<u8>, _> =
        ImageBuffer::from_raw(width, height, image_data).ok_or("Failed to create image buffer")?;

    let output_image_path = PathBuf::from(
        "/Users/richie/Library/Application Support/so.cap.desktop-solid/recordings/ac2909e0-2f5e-45ff-95e3-8efb50a56a12.cap/output/result.png"
    );

    println!("Saving the image to {:?}", output_image_path);
    image_buffer.save(&output_image_path)?;

    println!("Unmapping the buffer...");
    drop(data);
    buffer.unmap();

    println!("Render complete. Output saved to {:?}", output_image_path);
    Ok(output_image_path)
}

// This is manual right now. You'd need to change the paths to your own directories.
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    #[tokio::test]
    async fn test_render_video() {
        // Create temporary files for input videos
        let temp_dir = std::env::temp_dir();
        let screen_recording_path = temp_dir.join(
            "/Users/richie/Library/Application Support/so.cap.desktop-solid/recordings/ac2909e0-2f5e-45ff-95e3-8efb50a56a12.cap/content/display.mp4"
        );
        let webcam_recording_path = temp_dir.join(
            "/Users/richie/Library/Application Support/so.cap.desktop-solid/recordings/ac2909e0-2f5e-45ff-95e3-8efb50a56a12.cap/content/camera.mp4"
        );

        // Set up render options
        let options = RenderOptions {
            screen_recording_path,
            webcam_recording_path,
            webcam_size: (320, 240),
            webcam_position: (0.05, 0.85),
            webcam_style: WebcamStyle {
                border_radius: 10.0,
                shadow_color: [0.0, 0.0, 0.0, 0.5],
                shadow_blur: 5.0,
                shadow_offset: (2.0, 2.0),
            },
            output_size: (4112, 2658),
            background: Background::Gradient {
                start: [0.1, 0.2, 0.3, 1.0],
                end: [0.3, 0.4, 0.5, 1.0],
                angle: 45.0,
            },
        };

        // Run the render_video function
        let result = render_video(options).await;

        // Check if the rendering was successful
        assert!(result.is_ok(), "Video rendering failed: {:?}", result.err());

        // Get the output path
        let output_path = result.unwrap();

        // Check if the output file exists
        assert!(output_path.exists(), "Output file does not exist");

        // Check if the output file has a non-zero size
        let metadata = fs::metadata(&output_path).unwrap();
        assert!(metadata.len() > 0, "Output file is empty");
    }
}
