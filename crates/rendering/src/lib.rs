use anyhow::Result;
use bytemuck::{Pod, Zeroable};
use futures_intrusive::channel::shared::oneshot_channel;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use wgpu::util::DeviceExt;
use wgpu::{TextureView, COPY_BYTES_PER_ROW_ALIGNMENT};

use cap_ffmpeg::{ffmpeg_path_as_str, FFmpeg, FFmpegRawVideoInput};
use cap_project::{BackgroundSource, CameraXPosition, CameraYPosition, ProjectConfiguration};

use std::io::{BufReader, Read};
use std::process::Command;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RenderOptions {
    pub screen_recording_path: PathBuf,
    pub webcam_recording_path: PathBuf,
    pub camera_size: (u32, u32),
    pub screen_size: (u32, u32),
    // pub webcam_style: WebcamStyle,
    pub output_size: (u32, u32),
    // pub background: Background,
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
    // static inputs
    background_start: [f32; 4],
    background_end: [f32; 4],

    shadow_color: [f32; 4],
    shadow_offset: [f32; 2],

    webcam_position: [f32; 2],
    // webcam_size: [f32; 2],
    screen_padding: f32,
    screen_rounding: f32,
    camera_rounding: f32,

    _padding1: f32,

    shadow_blur: f32,

    background_angle: f32,
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

#[derive(Debug, Clone, Copy)]
pub struct UV<T> {
    pub u: T,
    pub v: T,
}

impl<T> UV<T> {
    pub fn new(x: T, y: T) -> Self {
        Self { u: x, v: y }
    }
}

impl<T> From<UV<T>> for (T, T) {
    fn from(xy: UV<T>) -> Self {
        (xy.u, xy.v)
    }
}

impl<T> From<UV<T>> for [T; 2] {
    fn from(xy: UV<T>) -> Self {
        [xy.u, xy.v]
    }
}

pub async fn render_video_to_file(
    options: RenderOptions,
    project: ProjectConfiguration,
    output_path: PathBuf,
) -> Result<PathBuf, String> {
    let (tx_image_data, rx_image_data) = mpsc::channel::<Vec<u8>>();

    let output_folder = output_path.parent().unwrap();
    std::fs::create_dir_all(&output_folder)
        .map_err(|e| format!("Failed to create output directory: {:?}", e))?;
    let output_path_clone = output_path.clone();

    thread::spawn(move || {
        println!("Starting FFmpeg output process...");
        let mut ffmpeg = FFmpeg::new();
        let ffmpeg_input = ffmpeg.add_input(FFmpegRawVideoInput {
            width: options.output_size.0,
            height: options.output_size.1,
            fps: 30,
            pix_fmt: "rgba",
            input: "pipe:0".into(),
        });

        ffmpeg
            .command
            .args(["-f", "mp4", "-map", &format!("{}:v", ffmpeg_input.index)])
            .args(["-codec:v", "libx264", "-preset", "ultrafast"])
            .args(["-pix_fmt", "yuv420p", "-tune", "zerolatency"])
            .arg("-y")
            .arg(&output_path_clone);

        let mut ffmpeg_process = ffmpeg.start();

        loop {
            match rx_image_data.recv() {
                Ok(frame) => {
                    // println!("Sending image data to FFmpeg");
                    if let Err(e) = ffmpeg_process.write_video_frame(&frame) {
                        eprintln!("Error writing video frame: {:?}", e);
                        break;
                    }
                }
                Err(_) => {
                    println!("All frames sent to FFmpeg");
                    break;
                }
            }
        }

        println!("Stopping FFmpeg process...");
        ffmpeg_process.stop();
    });

    render_video_to_channel(options, project, tx_image_data).await?;

    Ok(output_path)
}

pub async fn render_video_to_channel(
    options: RenderOptions,
    project: ProjectConfiguration,
    sender: mpsc::Sender<Vec<u8>>,
) -> Result<(), String> {
    let constants = RenderVideoConstants::new(options).await?;
    let options = &constants.options;

    let (background_start, background_end, _background_angle) = match &project.background.source {
        BackgroundSource::Color { value } => (
            [
                srgb_to_linear(value[0]),
                srgb_to_linear(value[1]),
                srgb_to_linear(value[2]),
                1.0,
            ],
            [
                srgb_to_linear(value[0]),
                srgb_to_linear(value[1]),
                srgb_to_linear(value[2]),
                1.0,
            ],
            0.0,
        ),
        BackgroundSource::Gradient {
            from,
            to, /*angle*/
        } => (
            [
                srgb_to_linear(from[0]),
                srgb_to_linear(from[1]),
                srgb_to_linear(from[2]),
                1.0,
            ],
            [
                srgb_to_linear(to[0]),
                srgb_to_linear(to[1]),
                srgb_to_linear(to[2]),
                1.0,
            ],
            0.0,
        ),
        _ => todo!(),
    };

    const CAMERA_PADDING: f32 = 50.0;
    const CAMERA_UV_WIDTH: f32 = 0.3;

    let camera_padding = UV::new(
        CAMERA_PADDING / options.output_size.0 as f32,
        CAMERA_PADDING / options.output_size.1 as f32,
    );

    let webcam_size = options.output_size.1 as f32 * CAMERA_UV_WIDTH;

    let webcam_position = {
        let x = match &project.camera.position.x {
            CameraXPosition::Left => camera_padding.u,
            CameraXPosition::Center => 0.5 - (webcam_size / options.output_size.0 as f32) / 2.0,
            CameraXPosition::Right => {
                1.0 - camera_padding.u - webcam_size / options.output_size.0 as f32
            }
        };
        let y = match &project.camera.position.y {
            CameraYPosition::Top => camera_padding.v,
            CameraYPosition::Bottom => 1.0 - CAMERA_UV_WIDTH - camera_padding.v,
        };

        UV::new(x, y)
    };

    let screen_uniforms_buffer = constants.device.create_buffer_init(
        &(wgpu::util::BufferInitDescriptor {
            label: Some("Uniform Buffer"),
            contents: bytemuck::cast_slice(&[render_frame::Uniforms {
                fb_size: [options.screen_size.0 as f32, options.screen_size.1 as f32],
                border_pc: project.background.rounding as f32,
                x_offset: 0.0,
                mirror: false as u32,
                _padding: [0.0],
            }]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        }),
    );

    let camera_uniforms_buffer = constants.device.create_buffer_init(
        &(wgpu::util::BufferInitDescriptor {
            label: Some("Uniform Buffer 2"),
            contents: bytemuck::cast_slice(&[render_frame::Uniforms {
                fb_size: [options.camera_size.1 as f32, options.camera_size.1 as f32],
                border_pc: project.camera.rounding as f32,
                x_offset: (options.camera_size.0 - options.camera_size.1) as f32 / 2.0,
                mirror: project.camera.mirror as u32,
                _padding: [0.0],
            }]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        }),
    );

    let screen_xy = (
        options.output_size.0 as f32 / 2.0,
        options.output_size.1 as f32 / 2.0,
    );
    let screen_scale = 1.0 - project.background.padding as f32 / 100.0;

    let output_ratio = options.output_size.0 as f32 / options.output_size.1 as f32;
    let screen_ratio = options.screen_size.0 as f32 / options.screen_size.1 as f32;
    let camera_ratio = options.camera_size.0 as f32 / options.camera_size.1 as f32;

    let screen_size_uv = UV::new(screen_scale * (screen_ratio / output_ratio), screen_scale);

    let screen_uv = UV::new(
        ((screen_xy.0 / options.output_size.0 as f32) - 0.5)
            + (1.0 - screen_scale) / 2.0
            + (screen_scale - screen_size_uv.u) / 2.0,
        ((screen_xy.1 / options.output_size.1 as f32) - 0.5) + (1.0 - screen_scale) / 2.0,
    );

    let composite_uniforms_buffer = constants.device.create_buffer_init(
        &(wgpu::util::BufferInitDescriptor {
            label: Some("Uniform Buffer 2"),
            contents: bytemuck::cast_slice(&[composite::Uniforms {
                screen_bounds: [screen_uv.u, screen_uv.v, screen_size_uv.u, screen_size_uv.v],
                webcam_bounds: [
                    webcam_position.u,
                    webcam_position.v,
                    CAMERA_UV_WIDTH * (camera_ratio / output_ratio),
                    CAMERA_UV_WIDTH,
                ],
                background_start,
                background_end,
            }]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        }),
    );

    println!("Setting up FFmpeg input for screen recording...");

    let ffmpeg_binary_path_str = ffmpeg_path_as_str().unwrap().to_owned();

    let screen_frame_size = (options.screen_size.0 * options.screen_size.1 * 4) as usize;
    let webcam_frame_size = (options.camera_size.0 * options.camera_size.1 * 4) as usize;

    let (screen_tx, mut screen_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let (webcam_tx, mut webcam_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let (render_tx, render_rx) = mpsc::channel();

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
            &format!("{}x{}", options.screen_size.0, options.screen_size.1),
            "-c:v",
            "rawvideo",
            "pipe:1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    thread::spawn(move || {
        let mut screen_output = screen_command
            .spawn()
            .expect("Failed to spawn screen FFmpeg process");

        let mut reader = BufReader::new(screen_output.stdout.take().unwrap());
        let mut buffer = vec![0u8; screen_frame_size];

        loop {
            match reader.read_exact(&mut buffer) {
                Ok(_) => {
                    if screen_tx.send(buffer.clone()).is_err() {
                        println!("Error sending screen frame to renderer");
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    println!("Reached end of screen stream");
                    break;
                }
                Err(e) => {
                    println!("Error reading screen frame: {:?}", e);
                    break;
                }
            }
        }
        let _ = screen_output.kill();
    });

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
            &format!("{}x{}", options.camera_size.0, options.camera_size.1),
            "-c:v",
            "rawvideo",
            "pipe:1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    thread::spawn(move || {
        let mut webcam_output = webcam_command
            .spawn()
            .expect("Failed to spawn webcam FFmpeg process");

        let mut reader = BufReader::new(webcam_output.stdout.take().unwrap());
        let mut buffer = vec![0u8; webcam_frame_size];

        loop {
            match reader.read_exact(&mut buffer) {
                Ok(_) => {
                    if webcam_tx.send(buffer.clone()).is_err() {
                        println!("Error sending webcam frame to renderer");
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    println!("Reached end of webcam stream");
                    break;
                }
                Err(e) => {
                    println!("Error reading webcam frame: {:?}", e);
                    break;
                }
            }
        }
        let _ = webcam_output.kill();
    });

    let start_time = Instant::now();
    let frame_count = Arc::new(AtomicUsize::new(0));
    let frame_count_clone = Arc::clone(&frame_count);

    let render_handle: tokio::task::JoinHandle<Result<(), String>> = tokio::spawn(async move {
        'render_loop: loop {
            let (screen_frame, camera_frame) =
                match tokio::join!(screen_rx.recv(), webcam_rx.recv()) {
                    (Some(screen), Some(webcam)) => {
                        // println!("Received screen frame from renderer");
                        (screen, webcam)
                    }
                    _ => {
                        break 'render_loop;
                    }
                };

            let frame = match produce_frame(
                &constants,
                &screen_uniforms_buffer,
                screen_frame,
                &camera_uniforms_buffer,
                camera_frame,
                &composite_uniforms_buffer,
            )
            .await
            {
                Ok(frame) => frame,
                Err(e) => {
                    eprintln!("{e}");
                    break 'render_loop;
                }
            };

            println!(
                "sending frame to channel. width {}, height {}, bytes {}",
                constants.options.output_size.0,
                constants.options.output_size.1,
                frame.len()
            );

            if sender.send(frame).is_err() {
                eprintln!("Failed to send processed frame to FFmpeg");
                break 'render_loop;
            }

            frame_count_clone.fetch_add(1, Ordering::SeqCst);
            if frame_count_clone.load(Ordering::SeqCst) % 30 == 0 {
                let elapsed = start_time.elapsed();
                println!(
                    "Processed {} frames in {:?} seconds",
                    frame_count_clone.load(Ordering::SeqCst),
                    elapsed.as_secs_f32()
                );
            }
        }

        println!("Render loop exited");
        println!("Sending stop signal");
        let _ = render_tx.send(());
        Ok(())
    });

    render_handle.await.map_err(|e| e.to_string())??;

    let _ = render_rx
        .recv()
        .map_err(|e| format!("Render channel error: {:?}", e))?;

    println!(
        "Rendering complete. Total frames: {}",
        frame_count.load(Ordering::SeqCst)
    );

    let total_frames = frame_count.load(Ordering::SeqCst);
    let total_time = start_time.elapsed();
    println!(
        "Render complete. Processed {} frames in {:?} seconds",
        total_frames,
        total_time.as_secs_f32()
    );

    Ok(())
}

struct RenderVideoConstants {
    pub _instance: wgpu::Instance,
    pub _adapter: wgpu::Adapter,
    pub queue: wgpu::Queue,
    pub device: wgpu::Device,
    pub options: RenderOptions,
    pub render_frame: RenderFrame,
    pub composite: Composite,
    pub output_texture: wgpu::Texture,
    pub output_texture_view: wgpu::TextureView,
    pub output_texture_size: wgpu::Extent3d,
    pub output_buffer: wgpu::Buffer,
    pub padded_bytes_per_row: u32,
    pub unpadded_bytes_per_row: u32,
}

impl RenderVideoConstants {
    pub async fn new(options: RenderOptions) -> Result<Self, String> {
        println!("Initializing wgpu...");
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::default());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .unwrap();
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default(), None)
            .await
            .map_err(|e| e.to_string())?;

        let output_texture_size = wgpu::Extent3d {
            width: options.output_size.0,
            height: options.output_size.1,
            depth_or_array_layers: 1,
        };

        let output_texture = device.create_texture(
            &(wgpu::TextureDescriptor {
                size: output_texture_size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
                label: Some("output_texture"),
                view_formats: &[],
            }),
        );

        // Calculate the aligned bytes per row
        let align = COPY_BYTES_PER_ROW_ALIGNMENT as u32;
        let unpadded_bytes_per_row = options.output_size.0 * 4;
        let padding = (align - (unpadded_bytes_per_row % align)) % align;
        let padded_bytes_per_row = unpadded_bytes_per_row + padding;

        // Ensure the padded_bytes_per_row is a multiple of 4 (32 bits)
        let padded_bytes_per_row = (padded_bytes_per_row + 3) & !3;

        let output_buffer_size = (padded_bytes_per_row * options.output_size.1) as u64;

        let output_buffer = device.create_buffer(
            &(wgpu::BufferDescriptor {
                size: output_buffer_size,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                label: Some("Output Buffer"),
                mapped_at_creation: false,
            }),
        );

        Ok(Self {
            composite: Composite::new(&device),
            render_frame: RenderFrame::new(&device),
            _instance: instance,
            _adapter: adapter,
            queue,
            device,
            options,
            output_texture_size,
            output_texture_view: output_texture
                .create_view(&wgpu::TextureViewDescriptor::default()),
            output_texture,
            output_buffer,
            unpadded_bytes_per_row,
            padded_bytes_per_row,
        })
    }
}

async fn produce_frame(
    RenderVideoConstants {
        device,
        options,
        render_frame,
        composite,
        queue,
        output_texture,
        output_texture_view,
        output_texture_size,
        output_buffer,
        padded_bytes_per_row,
        unpadded_bytes_per_row,
        ..
    }: &RenderVideoConstants,
    screen_uniforms_buffer: &wgpu::Buffer,
    screen_frame: Vec<u8>,
    camera_uniforms_buffer: &wgpu::Buffer,
    camera_frame: Vec<u8>,
    composite_uniforms_buffer: &wgpu::Buffer,
) -> Result<Vec<u8>, String> {
    let mut encoder = device.create_command_encoder(
        &(wgpu::CommandEncoderDescriptor {
            label: Some("Render Encoder"),
        }),
    );

    let screen_texture = device.create_texture(
        &(wgpu::TextureDescriptor {
            size: wgpu::Extent3d {
                width: options.screen_size.0,
                height: options.screen_size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
            label: Some("texture"),
            view_formats: &[],
        }),
    );

    let screen_texture_view = screen_texture.create_view(&wgpu::TextureViewDescriptor::default());

    let webcam_texture = device.create_texture(
        &(wgpu::TextureDescriptor {
            size: wgpu::Extent3d {
                width: options.camera_size.0,
                height: options.camera_size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
            label: Some("webcam texture"),
            view_formats: &[],
        }),
    );

    let webcam_texture_view = webcam_texture.create_view(&wgpu::TextureViewDescriptor::default());

    do_render_pass(
        &mut encoder,
        &screen_texture_view,
        &render_frame.render_pipeline,
        render_frame::bind_group(
            &device,
            &queue,
            &render_frame.bind_group_layout,
            &screen_uniforms_buffer,
            options.screen_size,
            screen_frame,
        ),
    );

    do_render_pass(
        &mut encoder,
        &webcam_texture_view,
        &render_frame.render_pipeline,
        render_frame::bind_group(
            &device,
            &queue,
            &render_frame.bind_group_layout,
            &camera_uniforms_buffer,
            options.camera_size,
            camera_frame,
        ),
    );

    do_render_pass(
        &mut encoder,
        &output_texture_view,
        &composite.render_pipeline,
        composite::bind_group(
            &device,
            &composite.bind_group_layout,
            &screen_texture_view,
            &webcam_texture_view,
            &composite_uniforms_buffer,
        ),
    );

    queue.submit(std::iter::once(encoder.finish()));

    {
        let mut encoder = device.create_command_encoder(
            &(wgpu::CommandEncoderDescriptor {
                label: Some("Copy Encoder"),
            }),
        );

        encoder.copy_texture_to_buffer(
            wgpu::ImageCopyTexture {
                texture: output_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::ImageCopyBuffer {
                buffer: &output_buffer,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(*padded_bytes_per_row),
                    rows_per_image: Some(options.output_size.1),
                },
            },
            *output_texture_size,
        );

        queue.submit(std::iter::once(encoder.finish()));
    }

    let buffer_slice = output_buffer.slice(..);
    let (tx, rx) = oneshot_channel();
    buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
        tx.send(result).unwrap();
    });
    device.poll(wgpu::Maintain::Wait);

    let Some(frame_result) = rx.receive().await else {
        return Err("2: Channel closed unexpectedly".to_string());
    };

    if let Err(e) = frame_result {
        return Err(format!("Failed to map buffer: {:?}", e));
    }

    let data = buffer_slice.get_mapped_range();
    let padded_data: Vec<u8> = data.to_vec(); // Ensure the type is Vec<u8>
    let mut image_data =
        Vec::with_capacity((options.output_size.0 * options.output_size.1 * 4) as usize);
    for chunk in padded_data.chunks(*padded_bytes_per_row as usize) {
        image_data.extend_from_slice(&chunk[..*unpadded_bytes_per_row as usize]);
    }

    // Unmap the buffer
    drop(data);
    output_buffer.unmap();

    Ok(image_data)
}

mod render_frame {
    use super::*;

    #[derive(Debug, Clone, Copy, Pod, Zeroable)]
    #[repr(C)]
    pub struct Uniforms {
        pub fb_size: [f32; 2],
        pub border_pc: f32,
        pub x_offset: f32,
        pub mirror: u32,
        pub _padding: [f32; 1],
    }

    pub const SHADER: &str = include_str!("shaders/render-frame.wgsl");

    pub fn bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        })
    }

    pub fn bind_group(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        layout: &wgpu::BindGroupLayout,
        uniform_buffer: &wgpu::Buffer,
        frame_size: (u32, u32),
        frame_data: Vec<u8>,
    ) -> wgpu::BindGroup {
        let texture = device.create_texture(
            &(wgpu::TextureDescriptor {
                size: wgpu::Extent3d {
                    width: frame_size.0,
                    height: frame_size.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                label: Some("texture"),
                view_formats: &[],
            }),
        );

        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        let sampler = device.create_sampler(
            &(wgpu::SamplerDescriptor {
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Nearest,
                mipmap_filter: wgpu::FilterMode::Nearest,
                ..Default::default()
            }),
        );

        let bind_group = device.create_bind_group(
            &(wgpu::BindGroupDescriptor {
                layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: uniform_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&texture_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&sampler),
                    },
                ],
                label: Some("bind_group"),
            }),
        );

        queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &frame_data,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(frame_size.0 * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: frame_size.0,
                height: frame_size.1,
                depth_or_array_layers: 1,
            },
        );

        bind_group
    }
}

struct Composite {
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub render_pipeline: wgpu::RenderPipeline,
}

impl Composite {
    pub fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = composite::bind_group_layout(&device);
        let render_pipeline =
            create_shader_render_pipeline(&device, &bind_group_layout, composite::SHADER);

        Self {
            bind_group_layout,
            render_pipeline,
        }
    }
}

struct RenderFrame {
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub render_pipeline: wgpu::RenderPipeline,
}

impl RenderFrame {
    pub fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = render_frame::bind_group_layout(&device);
        let render_pipeline =
            create_shader_render_pipeline(&device, &bind_group_layout, render_frame::SHADER);

        Self {
            bind_group_layout,
            render_pipeline,
        }
    }
}

mod composite {
    use super::*;

    #[derive(Debug, Clone, Copy, Pod, Zeroable)]
    #[repr(C)]
    pub struct Uniforms {
        pub screen_bounds: [f32; 4],
        pub webcam_bounds: [f32; 4],
        pub background_start: [f32; 4],
        pub background_end: [f32; 4],
    }

    pub const SHADER: &str = include_str!("shaders/composite.wgsl");

    pub fn bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Composite Everything Bind Group Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        })
    }

    pub fn bind_group(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        one: &wgpu::TextureView,
        two: &wgpu::TextureView,
        uniforms: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        let sampler = device.create_sampler(
            &(wgpu::SamplerDescriptor {
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Nearest,
                mipmap_filter: wgpu::FilterMode::Nearest,
                ..Default::default()
            }),
        );

        let bind_group = device.create_bind_group(
            &(wgpu::BindGroupDescriptor {
                layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: uniforms.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(one),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(two),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::Sampler(&sampler),
                    },
                ],
                label: Some("bind_group"),
            }),
        );

        bind_group
    }
}

fn do_render_pass(
    encoder: &mut wgpu::CommandEncoder,
    output_view: &wgpu::TextureView,
    render_pipeline: &wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
) {
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

fn create_shader_render_pipeline(
    device: &wgpu::Device,
    bind_group_layout: &wgpu::BindGroupLayout,
    wgsl_shader: &str,
) -> wgpu::RenderPipeline {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Shader"),
        source: wgpu::ShaderSource::Wgsl(wgsl_shader.into()),
    });

    let compilation_options = wgpu::PipelineCompilationOptions {
        constants: &HashMap::new(),
        zero_initialize_workgroup_memory: false,
        vertex_pulling_transform: false,
    };

    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Render Pipeline"),
        layout: Some(&device.create_pipeline_layout(
            &(wgpu::PipelineLayoutDescriptor {
                label: Some("Render Pipeline Layout"),
                bind_group_layouts: &[&bind_group_layout],
                push_constant_ranges: &[],
            }),
        )),
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
    })
}

fn srgb_to_linear(c: u16) -> f32 {
    let c = c as f32 / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}
