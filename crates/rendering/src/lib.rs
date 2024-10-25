use anyhow::Result;
use bytemuck::{Pod, Zeroable};
use decoder::AsyncVideoDecoderHandle;
use futures::future::OptionFuture;
use futures_intrusive::channel::shared::oneshot_channel;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::HashMap, sync::Arc};
use wgpu::util::DeviceExt;
use wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;

use cap_project::{
    AspectRatio, BackgroundSource, CameraXPosition, CameraYPosition, Crop, CursorData,
    ProjectConfiguration, XY,
};

use std::time::Instant;

pub mod decoder;
pub use decoder::DecodedFrame;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RenderOptions {
    pub camera_size: Option<(u32, u32)>,
    pub screen_size: (u32, u32),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WebcamStyle {
    pub border_radius: f32,
    pub shadow_color: [f32; 4],
    pub shadow_blur: f32,
    pub shadow_offset: (f32, f32),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Copy)]
pub enum Background {
    Color([f32; 4]),
    Gradient {
        start: [f32; 4],
        end: [f32; 4],
        angle: f32,
    },
}

impl From<BackgroundSource> for Background {
    fn from(value: BackgroundSource) -> Self {
        match value {
            BackgroundSource::Color { value } => Background::Color([
                srgb_to_linear(value[0]),
                srgb_to_linear(value[1]),
                srgb_to_linear(value[2]),
                1.0,
            ]),
            BackgroundSource::Gradient { from, to, angle } => Background::Gradient {
                start: [
                    srgb_to_linear(from[0]),
                    srgb_to_linear(from[1]),
                    srgb_to_linear(from[2]),
                    1.0,
                ],
                end: [
                    srgb_to_linear(to[0]),
                    srgb_to_linear(to[1]),
                    srgb_to_linear(to[2]),
                    1.0,
                ],
                angle: angle as f32,
            },
            _ => unimplemented!(),
        }
    }
}

#[derive(Clone)]
pub struct RecordingDecoders {
    screen: AsyncVideoDecoderHandle,
    camera: Option<AsyncVideoDecoderHandle>,
}

impl RecordingDecoders {
    pub fn new(screen: AsyncVideoDecoderHandle, camera: Option<AsyncVideoDecoderHandle>) -> Self {
        RecordingDecoders { screen, camera }
    }
    pub async fn get_frames(
        &self,
        frame_number: u32,
    ) -> Option<(DecodedFrame, Option<DecodedFrame>)> {
        let (screen_frame, camera_frame) = tokio::join!(
            self.screen.get_frame(frame_number),
            OptionFuture::from(self.camera.as_ref().map(|d| d.get_frame(frame_number)))
        );

        screen_frame.map(|f| (f, camera_frame.flatten()))
    }

    pub async fn stop(&self) {
        // Implement the stop logic for the decoders
        // This might involve stopping any running decoding tasks
        // and cleaning up resources
        if let Some(camera) = &self.camera {
            camera.stop().await;
        }
        self.screen.stop().await;
        println!("Decoders stopped");
    }
}

pub async fn render_video_to_channel(
    options: RenderOptions,
    project: ProjectConfiguration,
    sender: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    decoders: RecordingDecoders,
    cursor: Arc<CursorData>,
) -> Result<(), String> {
    let constants = RenderVideoConstants::new(options, cursor).await?;

    println!("Setting up FFmpeg input for screen recording...");

    ffmpeg::init().unwrap();

    let start_time = Instant::now();

    let duration = project.timeline().map(|t| t.duration()).unwrap_or(f64::MAX);

    let render_handle: tokio::task::JoinHandle<Result<u32, String>> = tokio::spawn(async move {
        let mut frame_number = 0;

        let background = Background::from(project.background.source.clone());

        loop {
            if frame_number as f64 > 30_f64 * duration {
                break;
            };

            let time = if let Some(timeline) = project.timeline() {
                match timeline.get_recording_time(frame_number as f64 / 30_f64) {
                    Some(time) => time,
                    None => break,
                }
            } else {
                frame_number as f64 / 30_f64
            };

            let uniforms = ProjectUniforms::new(&constants, &project, time as f32);

            let Some((screen_frame, camera_frame)) =
                decoders.get_frames((time * 30.0) as u32).await
            else {
                break;
            };

            let frame = match produce_frame(
                &constants,
                &screen_frame,
                &camera_frame,
                background,
                &uniforms,
            )
            .await
            {
                Ok(frame) => frame,
                Err(e) => {
                    eprintln!("{e}");
                    break;
                }
            };

            if sender.send(frame).is_err() {
                eprintln!("Failed to send processed frame to channel");
                break;
            }

            frame_number += 1;
            if frame_number % 60 == 0 {
                let elapsed = start_time.elapsed();
                println!(
                    "Rendered {} frames in {:?} seconds",
                    frame_number,
                    elapsed.as_secs_f32()
                );
            }
        }

        println!("Render loop exited");

        Ok(frame_number)
    });

    let total_frames = render_handle.await.map_err(|e| e.to_string())??;

    let total_time = start_time.elapsed();
    println!(
        "Render complete. Processed {} frames in {:?} seconds",
        total_frames,
        total_time.as_secs_f32()
    );

    Ok(())
}

pub struct RenderVideoConstants {
    pub _instance: wgpu::Instance,
    pub _adapter: wgpu::Adapter,
    pub queue: wgpu::Queue,
    pub device: wgpu::Device,
    pub options: RenderOptions,
    composite_video_frame_pipeline: CompositeVideoFramePipeline,
    gradient_or_color_pipeline: GradientOrColorPipeline,
    pub cursor: Arc<CursorData>,
}

impl RenderVideoConstants {
    pub async fn new(options: RenderOptions, cursor: Arc<CursorData>) -> Result<Self, String> {
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

        Ok(Self {
            composite_video_frame_pipeline: CompositeVideoFramePipeline::new(&device),
            gradient_or_color_pipeline: GradientOrColorPipeline::new(&device),
            _instance: instance,
            _adapter: adapter,
            queue,
            device,
            options,
            cursor,
        })
    }
}

#[derive(Clone, Debug)]
pub struct ProjectUniforms {
    pub output_size: (u32, u32),
    display: CompositeVideoFrameUniforms,
    camera: Option<CompositeVideoFrameUniforms>,
}

const CAMERA_PADDING: f32 = 50.0;

const SCREEN_MAX_PADDING: f32 = 0.4;

impl ProjectUniforms {
    fn get_crop(options: &RenderOptions, project: &ProjectConfiguration) -> Crop {
        project.background.crop.clone().unwrap_or(Crop {
            position: XY { x: 0, y: 0 },
            size: XY {
                x: options.screen_size.0,
                y: options.screen_size.1,
            },
        })
    }

    fn get_padding(options: &RenderOptions, project: &ProjectConfiguration) -> f32 {
        let crop = Self::get_crop(options, project);

        let basis = u32::max(crop.size.x, crop.size.y);
        let padding_factor = project.background.padding / 100.0 * SCREEN_MAX_PADDING;

        basis as f32 * padding_factor
    }

    pub fn get_output_size(options: &RenderOptions, project: &ProjectConfiguration) -> (u32, u32) {
        let crop = Self::get_crop(options, project);

        let crop_aspect = crop.aspect_ratio();

        let padding = Self::get_padding(options, project) * 2.0;

        let aspect = match &project.aspect_ratio {
            None => {
                let width = ((crop.size.x as f32 + padding) as u32 + 1) & !1;
                let height = ((crop.size.y as f32 + padding) as u32 + 1) & !1;
                return (width, height);
            }
            Some(AspectRatio::Square) => 1.0,
            Some(AspectRatio::Wide) => 16.0 / 9.0,
            Some(AspectRatio::Vertical) => 9.0 / 16.0,
            Some(AspectRatio::Classic) => 4.0 / 3.0,
            Some(AspectRatio::Tall) => 3.0 / 4.0,
        };

        let (width, height) = if crop_aspect > aspect {
            (crop.size.x, (crop.size.x as f32 / aspect) as u32)
        } else if crop_aspect < aspect {
            ((crop.size.y as f32 * aspect) as u32, crop.size.y)
        } else {
            (crop.size.x, crop.size.y)
        };

        // Ensure width and height are divisible by 2
        ((width + 1) & !1, (height + 1) & !1)
    }

    pub fn new(
        constants: &RenderVideoConstants,
        project: &ProjectConfiguration,
        time: f32,
    ) -> Self {
        let options = &constants.options;
        let output_size = Self::get_output_size(options, project);
        let output_aspect = output_size.0 as f32 / output_size.1 as f32;

        let cursor_position = interpolate_cursor_position(&constants.cursor, time);

        let display = {
            let output_size = [output_size.0 as f32, output_size.1 as f32];
            let size = [options.screen_size.0 as f32, options.screen_size.1 as f32];

            let crop = Self::get_crop(options, project);

            let crop_bounds = [
                crop.position.x as f32,
                crop.position.y as f32,
                (crop.position.x + crop.size.x) as f32,
                (crop.position.y + crop.size.y) as f32,
            ];

            let cropped_size = [
                crop_bounds[2] - crop_bounds[0],
                crop_bounds[3] - crop_bounds[1],
            ];
            let cropped_aspect = cropped_size[0] / cropped_size[1];

            let padding = Self::get_padding(options, project);
            let is_height_constrained = cropped_aspect <= output_aspect;

            let available_size = [
                output_size[0] - 2.0 * padding,
                output_size[1] - 2.0 * padding,
            ];

            let target_size = if is_height_constrained {
                [available_size[1] * cropped_aspect, available_size[1]]
            } else {
                [available_size[0], available_size[0] / cropped_aspect]
            };

            let target_offset = [
                (output_size[0] - target_size[0]) / 2.0,
                (output_size[1] - target_size[1]) / 2.0,
            ];

            let target_start = if is_height_constrained {
                [target_offset[0], padding]
            } else {
                [padding, target_offset[1]]
            };

            // pre-zoom
            let target_bounds = [
                target_start[0],
                target_start[1],
                output_size[0] - target_start[0],
                output_size[1] - target_start[1],
            ];
            let target_size = [
                target_bounds[2] - target_bounds[0],
                target_bounds[3] - target_bounds[1],
            ];

            let (zoom, zoom_origin_uv) = if let Some(cursor_position) = cursor_position {
                (
                    1.0,
                    (cursor_position.0 as f32, cursor_position.1 as f32),
                )
            } else {
                (1.0, (0.0, 0.0))
            };

            let screen_scale_origin = (
                target_bounds[0] + target_size[0] * zoom_origin_uv.0,
                target_bounds[1] + target_size[1] * zoom_origin_uv.1,
            );

            let apply_scale = |val, offset| (val - offset) * zoom as f32 + offset;

            // post-zoom
            let target_bounds = [
                apply_scale(target_bounds[0], screen_scale_origin.0),
                apply_scale(target_bounds[1], screen_scale_origin.1),
                apply_scale(target_bounds[2], screen_scale_origin.0),
                apply_scale(target_bounds[3], screen_scale_origin.1),
            ];
            let target_size = [
                target_bounds[2] - target_bounds[0],
                target_bounds[3] - target_bounds[1],
            ];
            let min_target_axis = target_size[0].min(target_size[1]);

            CompositeVideoFrameUniforms {
                output_size,
                frame_size: size,
                crop_bounds,
                target_bounds,
                target_size,
                rounding_px: project.background.rounding / 100.0 * 0.5 * min_target_axis,
                ..Default::default()
            }
        };

        let camera = options
            .camera_size
            .filter(|_| !project.camera.hide)
            .map(|camera_size| {
                let output_size = [output_size.0 as f32, output_size.1 as f32];

                let frame_size = [camera_size.0 as f32, camera_size.1 as f32];
                let min_axis = output_size[0].min(output_size[1]);

                let size = [
                    min_axis * project.camera.size / 100.0 + CAMERA_PADDING,
                    min_axis * project.camera.size / 100.0 + CAMERA_PADDING,
                ];

                let position = {
                    let x = match &project.camera.position.x {
                        CameraXPosition::Left => CAMERA_PADDING,
                        CameraXPosition::Center => output_size[0] / 2.0 - (size[0]) / 2.0,
                        CameraXPosition::Right => output_size[0] - CAMERA_PADDING - size[0],
                    };
                    let y = match &project.camera.position.y {
                        CameraYPosition::Top => CAMERA_PADDING,
                        CameraYPosition::Bottom => output_size[1] - size[1] - CAMERA_PADDING,
                    };

                    [x, y]
                };

                let target_bounds = [
                    position[0],
                    position[1],
                    position[0] + size[0],
                    position[1] + size[1],
                ];

                CompositeVideoFrameUniforms {
                    output_size,
                    frame_size,
                    crop_bounds: [
                        (frame_size[0] - frame_size[1]) / 2.0,
                        0.0,
                        frame_size[0] - (frame_size[0] - frame_size[1]) / 2.0,
                        frame_size[1],
                    ],
                    target_bounds,
                    target_size: [
                        target_bounds[2] - target_bounds[0],
                        target_bounds[3] - target_bounds[1],
                    ],
                    rounding_px: project.camera.rounding / 100.0 * 0.5 * size[0],
                    mirror_x: if project.camera.mirror { 1.0 } else { 0.0 },
                    ..Default::default()
                }
            });

        Self {
            output_size,
            display,
            camera,
        }
    }
}

pub async fn produce_frame(
    RenderVideoConstants {
        device,
        options,
        composite_video_frame_pipeline,
        gradient_or_color_pipeline,
        queue,
        ..
    }: &RenderVideoConstants,
    screen_frame: &Vec<u8>,
    camera_frame: &Option<DecodedFrame>,
    background: Background,
    uniforms: &ProjectUniforms,
) -> Result<Vec<u8>, String> {
    let mut encoder = device.create_command_encoder(
        &(wgpu::CommandEncoderDescriptor {
            label: Some("Render Encoder"),
        }),
    );

    let output_texture_desc = wgpu::TextureDescriptor {
        size: wgpu::Extent3d {
            width: uniforms.output_size.0,
            height: uniforms.output_size.1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8UnormSrgb,
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::COPY_SRC,
        label: Some("Intermediate Texture"),
        view_formats: &[],
    };

    let textures = (
        device.create_texture(&output_texture_desc),
        device.create_texture(&output_texture_desc),
    );

    let textures = (&textures.0, &textures.1);

    let texture_views = (
        textures
            .0
            .create_view(&wgpu::TextureViewDescriptor::default()),
        textures
            .1
            .create_view(&wgpu::TextureViewDescriptor::default()),
    );

    let texture_views = (&texture_views.0, &texture_views.1);

    let mut output_is_left = true;

    // background
    {
        do_render_pass(
            &mut encoder,
            get_either(texture_views, output_is_left),
            &gradient_or_color_pipeline.render_pipeline,
            gradient_or_color_pipeline.bind_group(
                device,
                &GradientOrColorUniforms::from(background).to_buffer(device),
            ),
        );

        output_is_left = !output_is_left;
    }

    // display
    {
        let frame_size = options.screen_size;

        let texture = device.create_texture(
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
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::COPY_DST,
                label: Some("Screen Frame texture"),
                view_formats: &[],
            }),
        );

        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            screen_frame,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(options.screen_size.0 * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: frame_size.0,
                height: frame_size.1,
                depth_or_array_layers: 1,
            },
        );

        do_render_pass(
            &mut encoder,
            get_either(texture_views, output_is_left),
            &composite_video_frame_pipeline.render_pipeline,
            composite_video_frame_pipeline.bind_group(
                device,
                &uniforms.display.to_buffer(device),
                &texture_view,
                get_either(texture_views, !output_is_left),
            ),
        );

        output_is_left = !output_is_left;
    }

    // camera
    if let (Some(camera_size), Some(camera_frame), Some(uniforms)) =
        (options.camera_size, camera_frame, &uniforms.camera)
    {
        let texture = device.create_texture(
            &(wgpu::TextureDescriptor {
                size: wgpu::Extent3d {
                    width: camera_size.0,
                    height: camera_size.1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::COPY_DST,
                label: Some("Camera texture"),
                view_formats: &[],
            }),
        );

        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            camera_frame,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(camera_size.0 * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: camera_size.0,
                height: camera_size.1,
                depth_or_array_layers: 1,
            },
        );

        do_render_pass(
            &mut encoder,
            get_either(texture_views, output_is_left),
            &composite_video_frame_pipeline.render_pipeline,
            composite_video_frame_pipeline.bind_group(
                device,
                &uniforms.to_buffer(device),
                &texture_view,
                get_either(texture_views, !output_is_left),
            ),
        );

        output_is_left = !output_is_left;
    }

    queue.submit(std::iter::once(encoder.finish()));

    let output_texture_size = wgpu::Extent3d {
        width: uniforms.output_size.0,
        height: uniforms.output_size.1,
        depth_or_array_layers: 1,
    };

    // Calculate the aligned bytes per row
    let align = COPY_BYTES_PER_ROW_ALIGNMENT;
    let unpadded_bytes_per_row = uniforms.output_size.0 * 4;
    let padding = (align - (unpadded_bytes_per_row % align)) % align;
    let padded_bytes_per_row = unpadded_bytes_per_row + padding;

    // Ensure the padded_bytes_per_row is a multiple of 4 (32 bits)
    let padded_bytes_per_row = (padded_bytes_per_row + 3) & !3;

    let output_buffer_size = (padded_bytes_per_row * uniforms.output_size.1) as u64;

    let output_buffer = device.create_buffer(
        &(wgpu::BufferDescriptor {
            size: output_buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            label: Some("Output Buffer"),
            mapped_at_creation: false,
        }),
    );

    {
        let mut encoder = device.create_command_encoder(
            &(wgpu::CommandEncoderDescriptor {
                label: Some("Copy Encoder"),
            }),
        );

        encoder.copy_texture_to_buffer(
            wgpu::ImageCopyTexture {
                texture: get_either(textures, !output_is_left),
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::ImageCopyBuffer {
                buffer: &output_buffer,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row),
                    rows_per_image: Some(uniforms.output_size.1),
                },
            },
            output_texture_size,
        );

        queue.submit(std::iter::once(encoder.finish()));
    }

    let buffer_slice = output_buffer.slice(..);
    let (tx, rx) = oneshot_channel();
    buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
        tx.send(result).ok();
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
        Vec::with_capacity((uniforms.output_size.0 * uniforms.output_size.1 * 4) as usize);
    for chunk in padded_data.chunks(padded_bytes_per_row as usize) {
        image_data.extend_from_slice(&chunk[..unpadded_bytes_per_row as usize]);
    }

    // Unmap the buffer
    drop(data);
    output_buffer.unmap();

    Ok(image_data)
}

struct CompositeVideoFramePipeline {
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub render_pipeline: wgpu::RenderPipeline,
}

#[derive(Debug, Clone, Copy, Pod, Zeroable, Default)]
#[repr(C)]
struct CompositeVideoFrameUniforms {
    pub crop_bounds: [f32; 4],
    pub target_bounds: [f32; 4],
    pub output_size: [f32; 2],
    pub frame_size: [f32; 2],
    pub velocity_uv: [f32; 2],
    pub target_size: [f32; 2],
    pub rounding_px: f32,
    pub mirror_x: f32,
    _padding: [f32; 3],
}

impl CompositeVideoFrameUniforms {
    fn to_buffer(self, device: &wgpu::Device) -> wgpu::Buffer {
        device.create_buffer_init(
            &(wgpu::util::BufferInitDescriptor {
                label: Some("CompositeVideoFrameUniforms Buffer"),
                contents: bytemuck::cast_slice(&[self]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
        )
    }
}

impl CompositeVideoFramePipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = Self::bind_group_layout(device);
        let render_pipeline =
            create_shader_render_pipeline(device, &bind_group_layout, Self::shader());

        Self {
            bind_group_layout,
            render_pipeline,
        }
    }

    fn shader() -> &'static str {
        include_str!("shaders/composite-video-frame.wgsl")
    }

    fn bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("composite-video-frame.wgsl Bind Group Layout"),
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
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        })
    }

    pub fn bind_group(
        &self,
        device: &wgpu::Device,
        uniforms: &wgpu::Buffer,
        frame: &wgpu::TextureView,
        intermediate: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        let sampler = device.create_sampler(
            &(wgpu::SamplerDescriptor {
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::FilterMode::Nearest,
                ..Default::default()
            }),
        );

        let bind_group = device.create_bind_group(
            &(wgpu::BindGroupDescriptor {
                layout: &self.bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: uniforms.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(frame),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(intermediate),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::Sampler(&sampler),
                    },
                ],
                label: Some("bind_group"),
            }),
        );

        bind_group
    }
}

struct GradientOrColorPipeline {
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub render_pipeline: wgpu::RenderPipeline,
}

#[derive(Debug, Clone, Copy, Pod, Zeroable, Default)]
#[repr(C)]
struct GradientOrColorUniforms {
    pub start: [f32; 4],
    pub end: [f32; 4],
    pub angle: f32,
    _padding: [f32; 3],
}

impl GradientOrColorUniforms {
    fn to_buffer(self, device: &wgpu::Device) -> wgpu::Buffer {
        device.create_buffer_init(
            &(wgpu::util::BufferInitDescriptor {
                label: Some("GradientOrColorUniforms Buffer"),
                contents: bytemuck::cast_slice(&[self]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
        )
    }
}

impl From<Background> for GradientOrColorUniforms {
    fn from(value: Background) -> Self {
        match value {
            Background::Color(color) => Self {
                start: color,
                end: color,
                angle: 0.0,
                _padding: [0.0; 3],
            },
            Background::Gradient { start, end, angle } => Self {
                start,
                end,
                angle,
                _padding: [0.0; 3],
            },
        }
    }
}

impl GradientOrColorPipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = Self::bind_group_layout(device);
        let render_pipeline =
            create_shader_render_pipeline(device, &bind_group_layout, Self::shader());

        Self {
            bind_group_layout,
            render_pipeline,
        }
    }

    fn shader() -> &'static str {
        include_str!("shaders/gradient-or-color.wgsl")
    }

    fn bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("composite-video-frame.wgsl Bind Group Layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        })
    }

    pub fn bind_group(&self, device: &wgpu::Device, uniforms: &wgpu::Buffer) -> wgpu::BindGroup {
        let bind_group = device.create_bind_group(
            &(wgpu::BindGroupDescriptor {
                layout: &self.bind_group_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniforms.as_entire_binding(),
                }],
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
                view: output_view,
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

    render_pass.set_pipeline(render_pipeline);
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
                bind_group_layouts: &[bind_group_layout],
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

fn get_either<T>((a, b): (T, T), left: bool) -> T {
    if left {
        a
    } else {
        b
    }
}

// Add this to the AsyncVideoDecoderHandle struct or impl block

impl AsyncVideoDecoderHandle {
    // ... (existing methods)

    pub async fn stop(&self) {
        // Implement the stop logic for the video decoder
        // This might involve sending a stop signal to a running task
        // or cleaning up resources
        println!("Video decoder stopped");
    }
}

fn interpolate_cursor_position(cursor: &CursorData, time_secs: f32) -> Option<(f64, d64)> {
	let time_ms = (time_secs * 1000.0) as f64;

    let cursor_position = if cursor.moves.len() == 0 {
        None
    } else {
        let moves = &cursor.moves;

        let mut position = 0;

        for (i, m) in moves.iter().enumerate() {
            if m.process_time_ms < time_ms && m.process_time_ms > moves[position].process_time_ms {
                position = i;
            }
        }

        let m = &moves[position];
        let next = moves.get(position + 1);

        let (x, y) = if let Some(next) = next {
            let delta = next.process_time_ms - m.process_time_ms;
            let progress = (time_ms - m.process_time_ms) / delta;
            (
                m.x + (next.x - m.x) * progress,
                m.y + (next.y - m.y) * progress,
            )
        } else {
            (m.x, m.y)
        };

        Some((x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)))
    }
}
