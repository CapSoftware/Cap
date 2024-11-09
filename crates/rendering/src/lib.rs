use anyhow::Result;
use bytemuck::{Pod, Zeroable};
use cap_flags::FLAGS;
use decoder::AsyncVideoDecoderHandle;
use futures::future::OptionFuture;
use futures_intrusive::channel::shared::oneshot_channel;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::ops::{Add, Deref, Mul, Sub};
use std::{collections::HashMap, sync::Arc};
use wgpu::util::DeviceExt;
use wgpu::{CommandEncoder, COPY_BYTES_PER_ROW_ALIGNMENT};

use cap_project::{
    AspectRatio, BackgroundSource, CameraXPosition, CameraYPosition, Crop,
    CursorData, CursorMoveEvent, ProjectConfiguration, XY,
};

use image::GenericImageView;
use std::path::PathBuf;
use std::time::Instant;

pub mod decoder;
pub use decoder::DecodedFrame;

const STANDARD_CURSOR_HEIGHT: f32 = 75.0;

#[derive(Debug, Clone, Type)]
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
    project_path: PathBuf, // Add project_path parameter
) -> Result<(), String> {
    let constants = RenderVideoConstants::new(options, cursor, project_path).await?;

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
                time as f32,
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
    pub cursor_textures: HashMap<String, wgpu::Texture>,
    cursor_pipeline: CursorPipeline,
}

impl RenderVideoConstants {
    pub async fn new(
        options: RenderOptions,
        cursor: Arc<CursorData>,
        project_path: PathBuf, // Add project_path parameter
    ) -> Result<Self, String> {
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

        // Pass project_path to load_cursor_textures
        let cursor_textures = Self::load_cursor_textures(&device, &queue, &cursor, &project_path)?;

        let cursor_pipeline = CursorPipeline::new(&device);

        Ok(Self {
            composite_video_frame_pipeline: CompositeVideoFramePipeline::new(&device),
            gradient_or_color_pipeline: GradientOrColorPipeline::new(&device),
            _instance: instance,
            _adapter: adapter,
            queue,
            device,
            options,
            cursor,
            cursor_textures,
            cursor_pipeline,
        })
    }

    fn load_cursor_textures(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        cursor: &CursorData,
        project_path: &PathBuf, // Add project_path parameter
    ) -> Result<HashMap<String, wgpu::Texture>, String> {
        println!("Starting to load cursor textures");
        println!("Project path: {:?}", project_path);
        println!("Cursor images to load: {:?}", cursor.cursor_images);

        let mut textures = HashMap::new();

        // Create the full path to the cursors directory
        let cursors_dir = project_path.join("content").join("cursors");
        println!("Cursors directory: {:?}", cursors_dir);

        for (cursor_id, filename) in &cursor.cursor_images {
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
        Ok(textures)
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

        let cursor_position = interpolate_cursor_position(&constants.cursor, time);

        let zoom_keyframes = ZoomKeyframes::new(project);
        let current_zoom = zoom_keyframes.get_amount(time as f64);
        let prev_zoom = zoom_keyframes.get_amount((time - 1.0 / 30.0) as f64);

        let velocity = if current_zoom != prev_zoom {
            let scale_change = (current_zoom - prev_zoom) as f32;
            // Reduce the velocity scale from 0.05 to 0.02
            [
                (scale_change * output_size.0 as f32) * 0.02, // Reduced from 0.05
                (scale_change * output_size.1 as f32) * 0.02,
            ]
        } else {
            [0.0, 0.0]
        };

        let motion_blur_amount = if current_zoom != prev_zoom {
            project.motion_blur.unwrap_or(0.2) // Reduced from 0.5 to 0.2
        } else {
            0.0
        };

        let zoom_origin_uv = if let Some(cursor_position) = cursor_position {
            (zoom_keyframes.get_amount(time as f64), cursor_position)
        } else {
            (1.0, Coord::new(XY { x: 0.0, y: 0.0 }))
        };

        let crop = Self::get_crop(options, project);

        let zoom_origin = if let Some(cursor_position) = cursor_position {
            cursor_position
                .to_raw_display_space(options)
                .to_cropped_display_space(options, project)
        } else {
            let center = XY::new(
                options.screen_size.x as f64 / 2.0,
                options.screen_size.y as f64 / 2.0,
            );
            Coord::<RawDisplaySpace>::new(center).to_cropped_display_space(options, project)
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
                amount: zoom_keyframes.get_amount(time as f64),
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
                    mirror_x: if project.camera.mirror { 1.0 } else { 0.0 },
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
                let zoom_amount = zoom_keyframes.get_amount(time as f64) as f32;
                let zoomed_size = if zoom_amount > 1.0 {
                    // Get the zoom size as a percentage (0-1 range)
                    let zoom_size = project.camera.zoom_size.unwrap_or(20.0) / 100.0;

                    // Smoothly interpolate between base size and zoom size
                    let t = (zoom_amount - 1.0) / 1.5; // Normalize to 0-1 range
                    let t = t.min(1.0); // Clamp to prevent over-scaling

                    // Lerp between base_size and zoom_size
                    base_size * (1.0 - t) + zoom_size * t
                } else {
                    base_size
                };

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
                    let zoom_delta = (current_zoom - prev_zoom).abs() as f32;

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

#[derive(Debug)]
pub struct ZoomKeyframe {
    time: f64,
    amount: f64,
}
#[derive(Debug)]
pub struct ZoomKeyframes(Vec<ZoomKeyframe>);

pub const ZOOM_DURATION: f64 = 0.6;

impl ZoomKeyframes {
    pub fn new(config: &ProjectConfiguration) -> Self {
        let Some(zoom_segments) = config.timeline().map(|t| &t.zoom_segments) else {
            return Self(vec![]);
        };

        if zoom_segments.is_empty() {
            return Self(vec![]);
        }

        let mut keyframes = vec![];

        for segment in zoom_segments {
            keyframes.push(ZoomKeyframe {
                time: segment.start,
                amount: 1.0,
            });
            keyframes.push(ZoomKeyframe {
                time: segment.start + ZOOM_DURATION,
                amount: segment.amount,
            });
            keyframes.push(ZoomKeyframe {
                time: segment.end,
                amount: segment.amount,
            });
            keyframes.push(ZoomKeyframe {
                time: segment.end + ZOOM_DURATION,
                amount: 1.0,
            });
        }

        Self(keyframes)
    }

    pub fn get_amount(&self, time: f64) -> f64 {
        if !FLAGS.zoom {
            return 1.0;
        }

        let prev_index = self
            .0
            .iter()
            .rev()
            .position(|k| time >= k.time)
            .map(|p| self.0.len() - 1 - p);

        let Some(prev_index) = prev_index else {
            return 1.0;
        };

        let next_index = prev_index + 1;

        let Some((prev, next)) = self.0.get(prev_index).zip(self.0.get(next_index)) else {
            return 1.0;
        };

        let keyframe_length = next.time - prev.time;
        let delta_time = time - prev.time;

        let t = delta_time / keyframe_length;
        let t = t.powf(0.5);

        prev.amount + (next.amount - prev.amount) * t
    }
}

pub async fn produce_frame(
    constants: &RenderVideoConstants,
    screen_frame: &Vec<u8>,
    camera_frame: &Option<DecodedFrame>,
    background: Background,
    uniforms: &ProjectUniforms,
    time: f32,
) -> Result<Vec<u8>, String> {
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

fn draw_cursor(
    constants: &RenderVideoConstants,
    uniforms: &ProjectUniforms,
    time: f32,
    encoder: &mut CommandEncoder,
    view: &wgpu::TextureView,
) {
    let Some(cursor_position) = interpolate_cursor_position(&constants.cursor, time) else {
        return;
    };

    // Calculate previous position for velocity
    let prev_position = interpolate_cursor_position(&constants.cursor, time - 1.0 / 30.0);

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

    let cursor_event = find_cursor_event(&constants.cursor, time);

    let last_click_time = constants
        .cursor
        .clicks
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

impl AsyncVideoDecoderHandle {
    // ... (existing methods)

    pub async fn stop(&self) {
        // Implement the stop logic for the video decoder
        // This might involve sending a stop signal to a running task
        // or cleaning up resources
        println!("Video decoder stopped");
    }
}

fn interpolate_cursor_position(
    cursor: &CursorData,
    time_secs: f32,
) -> Option<Coord<RawDisplayUVSpace>> {
    let time_ms = (time_secs * 1000.0) as f64;

    if cursor.moves.is_empty() {
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

        Some(Coord::new(XY {
            x: x.clamp(0.0, 1.0),
            y: y.clamp(0.0, 1.0),
        }))
    }
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
