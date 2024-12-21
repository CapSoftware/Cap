use anyhow::Result;
use bytemuck::{Pod, Zeroable};
use cap_flags::FLAGS;
use core::f64;
use decoder::{AsyncVideoDecoder, AsyncVideoDecoderHandle};
use futures::future::OptionFuture;
use futures_intrusive::channel::shared::oneshot_channel;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::ops::{Add, Deref, Mul, Sub};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::mpsc;
use wgpu::util::DeviceExt;
use wgpu::{CommandEncoder, COPY_BYTES_PER_ROW_ALIGNMENT};

use cap_project::{
    AspectRatio, BackgroundSource, CameraXPosition, CameraYPosition, Content, Crop,
    CursorAnimationStyle, CursorClickEvent, CursorData, CursorEvents, CursorMoveEvent,
    ProjectConfiguration, RecordingMeta, ZoomSegment, FAST_SMOOTHING_SAMPLES,
    FAST_VELOCITY_THRESHOLD, REGULAR_SMOOTHING_SAMPLES, REGULAR_VELOCITY_THRESHOLD,
    SLOW_SMOOTHING_SAMPLES, SLOW_VELOCITY_THRESHOLD, XY,
};

use image::GenericImageView;
use std::path::Path;
use std::time::Instant;

pub mod decoder;
mod project_recordings;
mod zoom;
pub use decoder::DecodedFrame;
pub use project_recordings::{ProjectRecordings, SegmentRecordings};

use zoom::*;

const STANDARD_CURSOR_HEIGHT: f32 = 75.0;

#[derive(Debug, Clone, Copy, Type)]
pub struct RenderOptions {
    pub camera_size: Option<XY<u32>>,
    pub screen_size: XY<u32>,
}

#[derive(Debug, Clone, Type)]
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
pub struct RecordingSegmentDecoders {
    screen: AsyncVideoDecoderHandle,
    camera: Option<AsyncVideoDecoderHandle>,
}

pub struct SegmentVideoPaths<'a> {
    pub display: &'a Path,
    pub camera: Option<&'a Path>,
}

impl RecordingSegmentDecoders {
    pub fn new(meta: &RecordingMeta, segment: SegmentVideoPaths) -> Self {
        let screen = AsyncVideoDecoder::spawn(meta.project_path.join(segment.display));
        let camera = segment
            .camera
            .map(|camera| AsyncVideoDecoder::spawn(meta.project_path.join(camera)));

        Self { screen, camera }
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
}

#[derive(thiserror::Error, Debug)]
pub enum RenderingError {
    #[error("No GPU adapter found")]
    NoAdapter,
    #[error(transparent)]
    RequestDeviceFailed(#[from] wgpu::RequestDeviceError),
    #[error("Failed to wait for buffer mapping")]
    BufferMapWaitingFailed,
    #[error(transparent)]
    BufferMapFailed(#[from] wgpu::BufferAsyncError),
    #[error("Sending frame to channel failed")]
    ChannelSendFrameFailed(#[from] mpsc::error::SendError<RenderedFrame>),
}

pub struct RenderSegment {
    pub cursor: Arc<CursorEvents>,
    pub decoders: RecordingSegmentDecoders,
}

pub async fn render_video_to_channel(
    options: RenderOptions,
    project: ProjectConfiguration,
    sender: mpsc::Sender<RenderedFrame>,
    meta: &RecordingMeta,
    segments: Vec<RenderSegment>,
) -> Result<(), RenderingError> {
    let constants = RenderVideoConstants::new(options, meta).await?;
    let recordings = ProjectRecordings::new(meta);

    ffmpeg::init().unwrap();

    let start_time = Instant::now();

    let duration = project
        .timeline()
        .map(|t| t.duration())
        .unwrap_or(recordings.duration());

    println!("export duration: {duration}");
    println!("export duration: {duration}");

    let mut frame_number = 0;

    let background = Background::from(project.background.source.clone());

    loop {
        if frame_number as f64 > 30_f64 * duration {
            break;
        };

        let (time, segment_i) = if let Some(timeline) = project.timeline() {
            match timeline.get_recording_time(frame_number as f64 / 30_f64) {
                Some(value) => value,
                None => {
                    println!("no time");
                    break;
                }
            }
        } else {
            (frame_number as f64 / 30_f64, None)
        };

        let segment = &segments[segment_i.unwrap_or(0) as usize];

        let uniforms = ProjectUniforms::new(&constants, &project, time as f32);

        if let Some((screen_frame, camera_frame)) =
            segment.decoders.get_frames((time * 30.0) as u32).await
        {
            let frame = produce_frame(
                &constants,
                &screen_frame,
                &camera_frame,
                background,
                &uniforms,
                time as f32,
            )
            .await?;

            sender.send(frame).await?;
        } else {
            println!("no decoder frames: {:?}", (time, segment_i));
        };

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

    let total_frames = frame_number;

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
    pub cursor_textures: HashMap<String, wgpu::Texture>,
    cursor_pipeline: CursorPipeline,
}

impl RenderVideoConstants {
    pub async fn new(options: RenderOptions, meta: &RecordingMeta) -> Result<Self, RenderingError> {
        println!("Initializing wgpu...");
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::default());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .ok_or(RenderingError::NoAdapter)?;
        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    required_features: wgpu::Features::MAPPABLE_PRIMARY_BUFFERS,
                    ..Default::default()
                },
                None,
            )
            .await?;

        // Pass project_path to load_cursor_textures
        let cursor_textures = Self::load_cursor_textures(&device, &queue, meta);

        let cursor_pipeline = CursorPipeline::new(&device);

        Ok(Self {
            composite_video_frame_pipeline: CompositeVideoFramePipeline::new(&device),
            gradient_or_color_pipeline: GradientOrColorPipeline::new(&device),
            _instance: instance,
            _adapter: adapter,
            queue,
            device,
            options,
            cursor_textures,
            cursor_pipeline,
        })
    }

    fn load_cursor_textures(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        meta: &RecordingMeta,
    ) -> HashMap<String, wgpu::Texture> {
        println!("Starting to load cursor textures");
        println!("Project path: {:?}", meta.project_path);
        // println!("Cursor images to load: {:?}", cursor.cursor_images);

        let mut textures = HashMap::new();

        // Create the full path to the cursors directory
        let cursors_dir = meta.project_path.join("content").join("cursors");
        println!("Cursors directory: {:?}", cursors_dir);

        let cursor_images = match &meta.content {
            Content::SingleSegment { segment } => segment.cursor_data(meta).cursor_images,
            Content::MultipleSegments { inner } => inner.cursor_images(meta).unwrap_or_default(),
        };

        for (cursor_id, filename) in &cursor_images.0 {
            println!("Loading cursor image: {} -> {}", cursor_id, filename);

            let cursor_path = cursors_dir.join(filename);
            println!("Full cursor path: {:?}", cursor_path);

            if !cursor_path.exists() {
                println!("Cursor image file does not exist: {:?}", cursor_path);
                continue;
            }

            match image::open(&cursor_path) {
                Ok(img) => {
                    let dimensions = img.dimensions();
                    println!(
                        "Loaded cursor image dimensions: {}x{}",
                        dimensions.0, dimensions.1
                    );

                    let rgba = img.into_rgba8();

                    // Create the texture
                    let texture = device.create_texture(&wgpu::TextureDescriptor {
                        label: Some(&format!("Cursor Texture {}", cursor_id)),
                        size: wgpu::Extent3d {
                            width: dimensions.0,
                            height: dimensions.1,
                            depth_or_array_layers: 1,
                        },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: wgpu::TextureFormat::Rgba8UnormSrgb,
                        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                        view_formats: &[],
                    });

                    queue.write_texture(
                        wgpu::ImageCopyTexture {
                            texture: &texture,
                            mip_level: 0,
                            origin: wgpu::Origin3d::ZERO,
                            aspect: wgpu::TextureAspect::All,
                        },
                        &rgba,
                        wgpu::ImageDataLayout {
                            offset: 0,
                            bytes_per_row: Some(4 * dimensions.0),
                            rows_per_image: None,
                        },
                        wgpu::Extent3d {
                            width: dimensions.0,
                            height: dimensions.1,
                            depth_or_array_layers: 1,
                        },
                    );

                    textures.insert(cursor_id.clone(), texture);
                    println!("Successfully loaded cursor texture: {}", cursor_id);
                }
                Err(e) => {
                    println!("Failed to load cursor image {}: {}", filename, e);
                    // Don't return error, just skip this cursor image
                    continue;
                }
            }
        }

        println!(
            "Completed loading cursor textures. Total loaded: {}",
            textures.len()
        );
        textures
    }
}

#[derive(Clone, Debug)]
pub struct ProjectUniforms {
    pub output_size: (u32, u32),
    pub cursor_size: f32,
    display: CompositeVideoFrameUniforms,
    camera: Option<CompositeVideoFrameUniforms>,
    pub zoom: Zoom,
    pub project: ProjectConfiguration,
}

#[derive(Debug, Clone)]
pub struct Zoom {
    pub amount: f64,
    pub zoom_origin: Coord<FrameSpace>,
}

impl Zoom {
    pub fn apply_scale(&self, screen_position: Coord<FrameSpace>) -> Coord<FrameSpace> {
        (screen_position - self.zoom_origin) * self.amount + self.zoom_origin
    }
}

const CAMERA_PADDING: f32 = 50.0;

const SCREEN_MAX_PADDING: f64 = 0.4;

impl ProjectUniforms {
    fn get_crop(options: &RenderOptions, project: &ProjectConfiguration) -> Crop {
        project.background.crop.unwrap_or(Crop {
            position: XY { x: 0, y: 0 },
            size: XY {
                x: options.screen_size.x,
                y: options.screen_size.y,
            },
        })
    }

    fn get_padding(options: &RenderOptions, project: &ProjectConfiguration) -> f64 {
        let crop = Self::get_crop(options, project);

        let basis = u32::max(crop.size.x, crop.size.y);
        let padding_factor = project.background.padding / 100.0 * SCREEN_MAX_PADDING;

        basis as f64 * padding_factor
    }

    pub fn get_output_size(options: &RenderOptions, project: &ProjectConfiguration) -> (u32, u32) {
        let crop = Self::get_crop(options, project);

        let crop_aspect = crop.aspect_ratio();

        let padding = Self::get_padding(options, project) * 2.0;

        let aspect = match &project.aspect_ratio {
            None => {
                let width = ((crop.size.x as f64 + padding) as u32 + 1) & !1;
                let height = ((crop.size.y as f64 + padding) as u32 + 1) & !1;
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

    pub fn get_display_offset(
        options: &RenderOptions,
        project: &ProjectConfiguration,
    ) -> Coord<FrameSpace> {
        let output_size = Self::get_output_size(options, project);
        let output_size = XY::new(output_size.0 as f64, output_size.1 as f64);

        let output_aspect = output_size.x / output_size.y;

        let crop = Self::get_crop(options, project);

        let crop_start =
            Coord::<RawDisplaySpace>::new(XY::new(crop.position.x as f64, crop.position.y as f64));
        let crop_end = Coord::<RawDisplaySpace>::new(XY::new(
            (crop.position.x + crop.size.x) as f64,
            (crop.position.y + crop.size.y) as f64,
        ));

        let cropped_size = crop_end.coord - crop_start.coord;

        let cropped_aspect = cropped_size.x / cropped_size.y;

        let padding = Self::get_padding(options, project);
        let is_height_constrained = cropped_aspect <= output_aspect;

        let available_size = output_size - 2.0 * padding;

        let target_size = if is_height_constrained {
            XY::new(available_size.y * cropped_aspect, available_size.y)
        } else {
            XY::new(available_size.x, available_size.x / cropped_aspect)
        };

        let target_offset = (output_size - target_size) / 2.0;

        Coord::new(if is_height_constrained {
            XY::new(target_offset.x, padding)
        } else {
            XY::new(padding, target_offset.y)
        })
    }

    pub fn new(
        constants: &RenderVideoConstants,
        project: &ProjectConfiguration,
        time: f32,
    ) -> Self {
        let options = &constants.options;
        let output_size = Self::get_output_size(options, project);

        let cursor_position = interpolate_cursor_position(
            &Default::default(), /*constants.cursor*/
            time,
            &project.cursor.animation_style,
        );

        let zoom_keyframes = ZoomKeyframes::new(project);
        let current_zoom = zoom_keyframes.interpolate(time as f64);
        let prev_zoom = zoom_keyframes.interpolate((time - 1.0 / 30.0) as f64);

        let velocity = if current_zoom.amount != prev_zoom.amount {
            let scale_change = (current_zoom.amount - prev_zoom.amount) as f32;
            // Reduce the velocity scale from 0.05 to 0.02
            [
                (scale_change * output_size.0 as f32) * 0.02, // Reduced from 0.05
                (scale_change * output_size.1 as f32) * 0.02,
            ]
        } else {
            [0.0, 0.0]
        };

        let motion_blur_amount = if current_zoom.amount != prev_zoom.amount {
            project.motion_blur.unwrap_or(0.2) // Reduced from 0.5 to 0.2
        } else {
            0.0
        };

        let crop = Self::get_crop(options, project);

        let interpolated_zoom = zoom_keyframes.interpolate(time as f64);

        let (zoom_amount, zoom_origin) = {
            let origin = match interpolated_zoom.position {
                ZoomPosition::Manual { x, y } => Coord::<RawDisplayUVSpace>::new(XY {
                    x: x as f64,
                    y: y as f64,
                })
                .to_raw_display_space(options)
                .to_cropped_display_space(options, project),
                ZoomPosition::Cursor => {
                    if let Some(cursor_position) = cursor_position {
                        cursor_position
                            .to_raw_display_space(options)
                            .to_cropped_display_space(options, project)
                    } else {
                        let center = XY::new(
                            options.screen_size.x as f64 / 2.0,
                            options.screen_size.y as f64 / 2.0,
                        );
                        Coord::<RawDisplaySpace>::new(center)
                            .to_cropped_display_space(options, project)
                    }
                }
            };

            (interpolated_zoom.amount, origin)
        };

        let (display, zoom) = {
            let output_size = XY::new(output_size.0 as f64, output_size.1 as f64);
            let size = [options.screen_size.x as f32, options.screen_size.y as f32];

            let crop_start = Coord::<RawDisplaySpace>::new(XY::new(
                crop.position.x as f64,
                crop.position.y as f64,
            ));
            let crop_end = Coord::<RawDisplaySpace>::new(XY::new(
                (crop.position.x + crop.size.x) as f64,
                (crop.position.y + crop.size.y) as f64,
            ));

            let display_offset = Self::get_display_offset(options, project);

            let end = Coord::new(output_size) - display_offset;

            let screen_scale_origin = zoom_origin
                .to_frame_space(options, project)
                .clamp(display_offset.coord, end.coord);

            let zoom = Zoom {
                amount: zoom_amount,
                zoom_origin: screen_scale_origin,
                // padding: screen_scale_origin,
            };

            let start = zoom.apply_scale(display_offset);
            let end = zoom.apply_scale(end);

            let target_size = end - start;
            let min_target_axis = target_size.x.min(target_size.y);

            (
                CompositeVideoFrameUniforms {
                    output_size: [output_size.x as f32, output_size.y as f32],
                    frame_size: size,
                    crop_bounds: [
                        crop_start.x as f32,
                        crop_start.y as f32,
                        crop_end.x as f32,
                        crop_end.y as f32,
                    ],
                    target_bounds: [start.x as f32, start.y as f32, end.x as f32, end.y as f32],
                    target_size: [target_size.x as f32, target_size.y as f32],
                    rounding_px: (project.background.rounding / 100.0 * 0.5 * min_target_axis)
                        as f32,
                    mirror_x: 0.0,
                    velocity_uv: velocity,
                    motion_blur_amount,
                    camera_motion_blur_amount: 0.0,
                    _padding: [0.0; 4],
                },
                zoom,
            )
        };

        let camera = options
            .camera_size
            .filter(|_| !project.camera.hide)
            .map(|camera_size| {
                let output_size = [output_size.0 as f32, output_size.1 as f32];
                let frame_size = [camera_size.x as f32, camera_size.y as f32];
                let min_axis = output_size[0].min(output_size[1]);

                // Calculate camera size based on zoom
                let base_size = project.camera.size / 100.0;
                let zoom_size = project.camera.zoom_size.unwrap_or(20.0) / 100.0;

                let zoomed_size = (interpolated_zoom.t as f32) * zoom_size * base_size
                    + (1.0 - interpolated_zoom.t as f32) * base_size;

                let size = [
                    min_axis * zoomed_size + CAMERA_PADDING,
                    min_axis * zoomed_size + CAMERA_PADDING,
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

                // Calculate camera motion blur based on zoom transition
                let camera_motion_blur = {
                    let base_blur = project.motion_blur.unwrap_or(0.2);
                    let zoom_delta = (current_zoom.amount - prev_zoom.amount).abs() as f32;

                    // Calculate a smooth transition factor
                    let transition_speed = 30.0f32; // Frames per second
                    let transition_factor = (zoom_delta * transition_speed).min(1.0);

                    // Reduce multiplier from 3.0 to 2.0 for weaker blur
                    (base_blur * 2.0 * transition_factor).min(1.0)
                };

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
                    velocity_uv: [0.0, 0.0],
                    motion_blur_amount,
                    camera_motion_blur_amount: camera_motion_blur,
                    _padding: [0.0; 4],
                }
            });

        Self {
            output_size,
            cursor_size: project.cursor.size as f32,
            display,
            camera,
            zoom,
            project: project.clone(),
        }
    }
}

#[derive(Clone)]
pub struct RenderedFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub padded_bytes_per_row: u32,
}

pub async fn produce_frame(
    constants: &RenderVideoConstants,
    screen_frame: &Vec<u8>,
    camera_frame: &Option<DecodedFrame>,
    background: Background,
    uniforms: &ProjectUniforms,
    time: f32,
) -> Result<RenderedFrame, RenderingError> {
    let mut encoder = constants.device.create_command_encoder(
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
        constants.device.create_texture(&output_texture_desc),
        constants.device.create_texture(&output_texture_desc),
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

    // First, clear the background
    {
        let bind_group = constants.gradient_or_color_pipeline.bind_group(
            &constants.device,
            &GradientOrColorUniforms::from(background).to_buffer(&constants.device),
        );

        do_render_pass(
            &mut encoder,
            get_either(texture_views, output_is_left),
            &constants.gradient_or_color_pipeline.render_pipeline,
            bind_group,
            wgpu::LoadOp::Clear(wgpu::Color::BLACK),
        );

        output_is_left = !output_is_left;
    }

    // Then render the screen frame
    {
        let frame_size = constants.options.screen_size;

        let texture = constants.device.create_texture(
            &(wgpu::TextureDescriptor {
                size: wgpu::Extent3d {
                    width: constants.options.screen_size.x,
                    height: constants.options.screen_size.y,
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

        constants.queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            screen_frame,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(constants.options.screen_size.x * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: frame_size.x,
                height: frame_size.y,
                depth_or_array_layers: 1,
            },
        );

        do_render_pass(
            &mut encoder,
            get_either(texture_views, output_is_left),
            &constants.composite_video_frame_pipeline.render_pipeline,
            constants.composite_video_frame_pipeline.bind_group(
                &constants.device,
                &uniforms.display.to_buffer(&constants.device),
                &texture_view,
                get_either(texture_views, !output_is_left),
            ),
            wgpu::LoadOp::Load, // Load existing content
        );

        output_is_left = !output_is_left;
    }

    if FLAGS.zoom {
        // Then render the cursor
        draw_cursor(
            constants,
            uniforms,
            time,
            &mut encoder,
            get_either(texture_views, !output_is_left),
        );
    }

    // camera
    if let (Some(camera_size), Some(camera_frame), Some(uniforms)) = (
        constants.options.camera_size,
        camera_frame,
        &uniforms.camera,
    ) {
        let texture = constants.device.create_texture(
            &(wgpu::TextureDescriptor {
                size: wgpu::Extent3d {
                    width: camera_size.x,
                    height: camera_size.y,
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

        constants.queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            camera_frame,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(camera_size.x * 4),
                rows_per_image: None,
            },
            wgpu::Extent3d {
                width: camera_size.x,
                height: camera_size.y,
                depth_or_array_layers: 1,
            },
        );

        do_render_pass(
            &mut encoder,
            get_either(texture_views, output_is_left),
            &constants.composite_video_frame_pipeline.render_pipeline,
            constants.composite_video_frame_pipeline.bind_group(
                &constants.device,
                &uniforms.to_buffer(&constants.device),
                &texture_view,
                get_either(texture_views, !output_is_left),
            ),
            wgpu::LoadOp::Load, // Load existing content
        );

        output_is_left = !output_is_left;
    }

    // Now submit the encoder
    constants.queue.submit(std::iter::once(encoder.finish()));

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

    let output_buffer = constants.device.create_buffer(&wgpu::BufferDescriptor {
        size: output_buffer_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        label: Some("Output Buffer"),
        mapped_at_creation: false,
    });

    {
        let mut encoder = constants.device.create_command_encoder(
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

        constants.queue.submit(std::iter::once(encoder.finish()));
    }

    let buffer_slice = output_buffer.slice(..);
    let (tx, rx) = oneshot_channel();
    buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
        tx.send(result).ok();
    });
    constants.device.poll(wgpu::Maintain::Wait);

    rx.receive()
        .await
        .ok_or(RenderingError::BufferMapWaitingFailed)??;

    let data = buffer_slice.get_mapped_range();

    let image_data = data.to_vec();

    // Unmap the buffer
    drop(data);
    output_buffer.unmap();

    Ok(RenderedFrame {
        data: image_data,
        padded_bytes_per_row,
        width: uniforms.output_size.0,
        height: uniforms.output_size.1,
    })
}

fn draw_cursor(
    constants: &RenderVideoConstants,
    uniforms: &ProjectUniforms,
    time: f32,
    encoder: &mut CommandEncoder,
    view: &wgpu::TextureView,
) {
    let Some(cursor_position) = interpolate_cursor_position(
        &Default::default(), // constants.cursor,
        time,
        &uniforms.project.cursor.animation_style,
    ) else {
        return;
    };

    // Calculate previous position for velocity
    let prev_position = interpolate_cursor_position(
        &Default::default(), // constants.cursor,
        time - 1.0 / 30.0,
        &uniforms.project.cursor.animation_style,
    );

    // Calculate velocity in screen space
    let velocity = if let Some(prev_pos) = prev_position {
        let curr_frame_pos = cursor_position.to_frame_space(&constants.options, &uniforms.project);
        let prev_frame_pos = prev_pos.to_frame_space(&constants.options, &uniforms.project);
        let frame_velocity = curr_frame_pos.coord - prev_frame_pos.coord;

        // Convert to pixels per frame
        [frame_velocity.x as f32, frame_velocity.y as f32]
    } else {
        [0.0, 0.0]
    };

    // Calculate motion blur amount based on velocity magnitude
    let speed = (velocity[0] * velocity[0] + velocity[1] * velocity[1]).sqrt();
    let motion_blur_amount = (speed * 0.3).min(1.0) * uniforms.project.motion_blur.unwrap_or(0.8);

    let cursor = Default::default();
    let cursor_event = find_cursor_event(&cursor /* constants.cursor */, time);

    let last_click_time =  /* constants
        .cursor
        .clicks */ Vec::<CursorClickEvent>::new()
        .iter()
        .filter(|click| click.down && click.process_time_ms <= (time as f64) * 1000.0)
        .max_by_key(|click| click.process_time_ms as i64)
        .map(|click| ((time as f64) * 1000.0 - click.process_time_ms) as f32 / 1000.0)
        .unwrap_or(1.0);

    let Some(cursor_texture) = constants.cursor_textures.get(&cursor_event.cursor_id) else {
        return;
    };

    let cursor_size = cursor_texture.size();
    let aspect_ratio = cursor_size.width as f32 / cursor_size.height as f32;

    let cursor_size_percentage = if uniforms.cursor_size <= 0.0 {
        100.0
    } else {
        uniforms.cursor_size / 100.0
    };

    let normalized_size = [
        STANDARD_CURSOR_HEIGHT * aspect_ratio * cursor_size_percentage,
        STANDARD_CURSOR_HEIGHT * cursor_size_percentage,
    ];

    let frame_position = cursor_position.to_frame_space(&constants.options, &uniforms.project);
    let position = uniforms.zoom.apply_scale(frame_position);
    let relative_position = [position.x as f32, position.y as f32];

    let cursor_uniforms = CursorUniforms {
        position: [relative_position[0], relative_position[1], 0.0, 0.0],
        size: [normalized_size[0], normalized_size[1], 0.0, 0.0],
        output_size: [
            uniforms.output_size.0 as f32,
            uniforms.output_size.1 as f32,
            0.0,
            0.0,
        ],
        screen_bounds: uniforms.display.target_bounds,
        cursor_size: cursor_size_percentage,
        last_click_time,
        velocity,
        motion_blur_amount,
        _alignment: [0.0; 7],
    };

    let cursor_uniform_buffer =
        constants
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Cursor Uniform Buffer"),
                contents: bytemuck::cast_slice(&[cursor_uniforms]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });

    let cursor_bind_group = constants
        .device
        .create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &constants.cursor_pipeline.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: cursor_uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &cursor_texture.create_view(&wgpu::TextureViewDescriptor::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(
                        &constants
                            .device
                            .create_sampler(&wgpu::SamplerDescriptor::default()),
                    ),
                },
            ],
            label: Some("Cursor Bind Group"),
        });

    let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("Cursor Render Pass"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
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

    render_pass.set_pipeline(&constants.cursor_pipeline.render_pipeline);
    render_pass.set_bind_group(0, &cursor_bind_group, &[]);
    render_pass.draw(0..4, 0..1);
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
    pub motion_blur_amount: f32,
    pub camera_motion_blur_amount: f32,
    _padding: [f32; 4],
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
    load_op: wgpu::LoadOp<wgpu::Color>,
) {
    let mut render_pass = encoder.begin_render_pass(
        &(wgpu::RenderPassDescriptor {
            label: Some("Render Pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: output_view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: load_op,
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

    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Render Pipeline Layout"),
        bind_group_layouts: &[bind_group_layout],
        push_constant_ranges: &[],
    });

    let empty_constants: HashMap<String, f64> = HashMap::new();

    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Render Pipeline"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: "vs_main",
            buffers: &[],
            compilation_options: wgpu::PipelineCompilationOptions {
                constants: &empty_constants,
                zero_initialize_workgroup_memory: false,
                vertex_pulling_transform: false,
            },
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: "fs_main",
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                blend: Some(wgpu::BlendState::REPLACE),
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: wgpu::PipelineCompilationOptions {
                constants: &empty_constants,
                zero_initialize_workgroup_memory: false,
                vertex_pulling_transform: false,
            },
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

fn interpolate_cursor_position(
    cursor: &CursorData,
    time_secs: f32,
    animation_style: &CursorAnimationStyle,
) -> Option<Coord<RawDisplayUVSpace>> {
    let time_ms = (time_secs * 1000.0) as f64;

    if cursor.moves.is_empty() {
        return None;
    }

    // Get style-specific parameters
    let (num_samples, velocity_threshold) = match animation_style {
        CursorAnimationStyle::Slow => (SLOW_SMOOTHING_SAMPLES, SLOW_VELOCITY_THRESHOLD),
        CursorAnimationStyle::Regular => (REGULAR_SMOOTHING_SAMPLES, REGULAR_VELOCITY_THRESHOLD),
        CursorAnimationStyle::Fast => (FAST_SMOOTHING_SAMPLES, FAST_VELOCITY_THRESHOLD),
    };

    // Find the closest move events around current time
    let mut closest_events: Vec<&CursorMoveEvent> = cursor
        .moves
        .iter()
        .filter(|m| (m.process_time_ms - time_ms).abs() <= 100.0) // Look at events within 100ms
        .collect();

    closest_events.sort_by(|a, b| {
        (a.process_time_ms - time_ms)
            .abs()
            .partial_cmp(&(b.process_time_ms - time_ms).abs())
            .unwrap()
    });

    // Take the nearest events up to num_samples
    let samples: Vec<(f64, f64, f64)> = closest_events
        .iter()
        .take(num_samples)
        .map(|m| (m.process_time_ms, m.x, m.y))
        .collect();

    if samples.is_empty() {
        // Fallback to nearest event if no samples in range
        let nearest = cursor
            .moves
            .iter()
            .min_by_key(|m| (m.process_time_ms - time_ms).abs() as i64)?;
        return Some(Coord::new(XY {
            x: nearest.x.clamp(0.0, 1.0),
            y: nearest.y.clamp(0.0, 1.0),
        }));
    }

    // Calculate velocities between consecutive points
    let mut velocities = Vec::with_capacity(samples.len() - 1);
    for i in 0..samples.len() - 1 {
        let (t1, x1, y1) = samples[i];
        let (t2, x2, y2) = samples[i + 1];
        let dt = (t2 - t1).max(1.0); // Avoid division by zero
        let dx = x2 - x1;
        let dy = y2 - y1;
        let velocity = ((dx * dx + dy * dy) / (dt * dt)).sqrt();
        velocities.push(velocity);
    }

    // Apply adaptive smoothing based on velocities and time distance
    let mut x = 0.0;
    let mut y = 0.0;
    let mut total_weight = 0.0;

    for (i, &(t, px, py)) in samples.iter().enumerate() {
        // Time-based weight with style-specific falloff
        let time_diff = (t - time_ms).abs();
        let style_factor = match animation_style {
            CursorAnimationStyle::Slow => 0.0005,
            CursorAnimationStyle::Regular => 0.001,
            CursorAnimationStyle::Fast => 0.002,
        };
        let time_weight = 1.0 / (1.0 + time_diff * style_factor);

        // Velocity-based weight
        let velocity_weight = if i < velocities.len() {
            let vel = velocities[i];
            if vel > velocity_threshold {
                (velocity_threshold / vel).powf(match animation_style {
                    CursorAnimationStyle::Slow => 1.5,
                    CursorAnimationStyle::Regular => 1.0,
                    CursorAnimationStyle::Fast => 0.5,
                })
            } else {
                1.0
            }
        } else {
            1.0
        };

        // Combine weights with style-specific emphasis
        let weight = match animation_style {
            CursorAnimationStyle::Slow => time_weight * velocity_weight.powf(1.5),
            CursorAnimationStyle::Regular => time_weight * velocity_weight,
            CursorAnimationStyle::Fast => time_weight * velocity_weight.powf(0.5),
        };

        x += px * weight;
        y += py * weight;
        total_weight += weight;
    }

    if total_weight > 0.0 {
        x /= total_weight;
        y /= total_weight;
    }

    Some(Coord::new(XY {
        x: x.clamp(0.0, 1.0),
        y: y.clamp(0.0, 1.0),
    }))
}

struct CursorPipeline {
    bind_group_layout: wgpu::BindGroupLayout,
    render_pipeline: wgpu::RenderPipeline,
}

#[repr(C, align(16))]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
struct CursorUniforms {
    position: [f32; 4],
    size: [f32; 4],
    output_size: [f32; 4],
    screen_bounds: [f32; 4],
    cursor_size: f32,
    last_click_time: f32,
    velocity: [f32; 2],
    motion_blur_amount: f32,
    _alignment: [f32; 7],
}

fn find_cursor_event(cursor: &CursorData, time: f32) -> &CursorMoveEvent {
    let time_ms = time * 1000.0;

    let event = cursor
        .moves
        .iter()
        .rev()
        .find(|event| {
            // println!("Checking event at time: {}ms", event.process_time_ms);
            event.process_time_ms <= time_ms.into()
        })
        .unwrap_or(&cursor.moves[0]);

    event
}

impl CursorPipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Cursor Pipeline Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: Some(std::num::NonZeroU64::new(112).unwrap()),
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
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Cursor Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/cursor.wgsl").into()),
        });

        let empty_constants: HashMap<String, f64> = HashMap::new();

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Cursor Pipeline"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("Cursor Pipeline Layout"),
                    bind_group_layouts: &[&bind_group_layout],
                    push_constant_ranges: &[],
                }),
            ),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_main",
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &empty_constants,
                    zero_initialize_workgroup_memory: false,
                    vertex_pulling_transform: false,
                },
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_main",
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::SrcAlpha,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &empty_constants,
                    zero_initialize_workgroup_memory: false,
                    vertex_pulling_transform: false,
                },
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Self {
            bind_group_layout,
            render_pipeline,
        }
    }
}

#[derive(Default, Clone, Copy, Debug)]
struct RawDisplaySpace;

// raw cursor data
#[derive(Default, Clone, Copy, Debug)]
struct RawDisplayUVSpace;

#[derive(Default, Clone, Copy, Debug)]
struct CroppedDisplaySpace;

#[derive(Default, Clone, Copy, Debug)]
pub struct FrameSpace;

#[derive(Default, Clone, Copy, Debug)]
struct TransformedDisplaySpace;

#[derive(Clone, Copy, Debug)]
pub struct Coord<TSpace> {
    coord: XY<f64>,
    space: TSpace,
}

impl<TSpace: Default> Coord<TSpace> {
    pub fn new(coord: XY<f64>) -> Self {
        Self {
            coord,
            space: TSpace::default(),
        }
    }

    pub fn clamp(self, min: XY<f64>, max: XY<f64>) -> Self {
        Self {
            coord: XY {
                x: self.coord.x.clamp(min.x, max.x),
                y: self.coord.y.clamp(min.y, max.y),
            },
            space: self.space,
        }
    }
}

impl<T> Deref for Coord<T> {
    type Target = XY<f64>;

    fn deref(&self) -> &Self::Target {
        &self.coord
    }
}

impl Coord<RawDisplayUVSpace> {
    fn to_raw_display_space(&self, options: &RenderOptions) -> Coord<RawDisplaySpace> {
        Coord::new(self.coord * options.screen_size.map(|v| v as f64))
    }

    fn to_frame_space(
        &self,
        options: &RenderOptions,
        project: &ProjectConfiguration,
    ) -> Coord<FrameSpace> {
        self.to_raw_display_space(options)
            .to_cropped_display_space(options, project)
            .to_frame_space(options, project)
    }
}

impl Coord<RawDisplaySpace> {
    fn to_cropped_display_space(
        &self,
        options: &RenderOptions,
        project: &ProjectConfiguration,
    ) -> Coord<CroppedDisplaySpace> {
        let crop = ProjectUniforms::get_crop(options, project);
        Coord::new(self.coord - crop.position.map(|v| v as f64))
    }
}

impl Coord<CroppedDisplaySpace> {
    fn to_frame_space(
        &self,
        options: &RenderOptions,
        project: &ProjectConfiguration,
    ) -> Coord<FrameSpace> {
        let padding = ProjectUniforms::get_display_offset(options, project);
        Coord::new(self.coord + *padding)
    }
}

impl<T> Add for Coord<T> {
    type Output = Self;

    fn add(self, rhs: Self) -> Self {
        Coord {
            coord: self.coord + rhs.coord,
            space: self.space,
        }
    }
}

impl<T> Sub for Coord<T> {
    type Output = Self;

    fn sub(self, rhs: Self) -> Self {
        Coord {
            coord: self.coord - rhs.coord,
            space: self.space,
        }
    }
}

impl<T> Mul<f64> for Coord<T> {
    type Output = Self;

    fn mul(self, rhs: f64) -> Self {
        Coord {
            coord: self.coord * rhs,
            space: self.space,
        }
    }
}
