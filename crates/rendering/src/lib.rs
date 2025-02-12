use anyhow::Result;
use bytemuck::{Pod, Zeroable};
use cap_project::{
    AspectRatio, BackgroundSource, CameraXPosition, CameraYPosition, Content, Crop,
    CursorAnimationStyle, CursorData, CursorEvents, CursorMoveEvent, ProjectConfiguration,
    RecordingMeta, FAST_SMOOTHING_SAMPLES, FAST_VELOCITY_THRESHOLD, REGULAR_SMOOTHING_SAMPLES,
    REGULAR_VELOCITY_THRESHOLD, SLOW_SMOOTHING_SAMPLES, SLOW_VELOCITY_THRESHOLD, XY,
};
use core::f64;
use decoder::{spawn_decoder, AsyncVideoDecoderHandle};
use frame_output::{FramePipelineEncoder, FramePipelineState};
use futures::future::OptionFuture;
use futures::FutureExt;
use layers::{
    BackgroundBlurPipeline, BackgroundLayer, CameraLayer, CursorLayer, CursorPipeline,
    DisplayLayer, GradientOrColorPipeline, ImageBackgroundPipeline,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::mpsc;
use wgpu::include_wgsl;
use wgpu::util::DeviceExt;

use image::GenericImageView;
use std::{path::PathBuf, time::Instant};

mod coord;
pub mod decoder;
mod frame_output;
mod layers;
mod project_recordings;
mod zoom;

pub use coord::*;
pub use decoder::DecodedFrame;
pub use project_recordings::{ProjectRecordings, SegmentRecordings, Video};

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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum Background {
    Color([f32; 4]),
    Gradient {
        start: [f32; 4],
        end: [f32; 4],
        angle: f32,
    },
    Image {
        path: String,
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
            BackgroundSource::Image { path } | BackgroundSource::Wallpaper { path } => {
                if let Some(path) = path {
                    if !path.is_empty() {
                        let clean_path = path
                            .replace("asset://localhost/", "/")
                            .replace("asset://", "")
                            .replace("localhost//", "/");

                        if std::path::Path::new(&clean_path).exists() {
                            return Background::Image { path: clean_path };
                        }
                    }
                }
                Background::Color([1.0, 1.0, 1.0, 1.0])
            }
        }
    }
}

#[derive(Clone)]
pub struct RecordingSegmentDecoders {
    screen: AsyncVideoDecoderHandle,
    camera: Option<AsyncVideoDecoderHandle>,
}

pub struct SegmentVideoPaths {
    pub display: PathBuf,
    pub camera: Option<PathBuf>,
}

impl RecordingSegmentDecoders {
    pub async fn new(meta: &RecordingMeta, segment: SegmentVideoPaths) -> Result<Self, String> {
        let screen = spawn_decoder(
            "screen",
            meta.project_path.join(segment.display),
            match &meta.content {
                Content::SingleSegment { segment } => segment.display.fps,
                Content::MultipleSegments { inner } => inner.segments[0].display.fps,
            },
        )
        .await
        .map_err(|e| format!("Screen:{e}"))?;
        let camera = OptionFuture::from(segment.camera.map(|camera| {
            spawn_decoder(
                "camera",
                meta.project_path.join(camera),
                match &meta.content {
                    Content::SingleSegment { segment } => segment.camera.as_ref().unwrap().fps,
                    Content::MultipleSegments { inner } => {
                        inner.segments[0].camera.as_ref().unwrap().fps
                    }
                },
            )
            .then(|r| async { r.map_err(|e| format!("Camera:{e}")) })
        }))
        .await
        .transpose()?;

        Ok(Self { screen, camera })
    }

    pub async fn get_frames(
        &self,
        segment_time: f32,
        needs_camera: bool,
    ) -> Option<DecodedSegmentFrames> {
        let (screen, camera) = tokio::join!(
            self.screen.get_frame(segment_time),
            OptionFuture::from(
                needs_camera
                    .then(|| self.camera.as_ref().map(|d| d.get_frame(segment_time)))
                    .flatten()
            )
        );

        Some(DecodedSegmentFrames {
            screen_frame: screen?,
            camera_frame: camera.flatten(),
            segment_time,
        })
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
    ChannelSendFrameFailed(#[from] mpsc::error::SendError<(RenderedFrame, u32)>),
    #[error("Failed to load image: {0}")]
    ImageLoadError(String),
}

pub struct RenderSegment {
    pub cursor: Arc<CursorEvents>,
    pub decoders: RecordingSegmentDecoders,
}

pub async fn render_video_to_channel(
    options: RenderOptions,
    project: ProjectConfiguration,
    sender: mpsc::Sender<(RenderedFrame, u32)>,
    meta: &RecordingMeta,
    segments: Vec<RenderSegment>,
    fps: u32,
    resolution_base: XY<u32>,
    is_upgraded: bool,
) -> Result<(), RenderingError> {
    let mut constants = RenderVideoConstants::new(options, meta).await?;
    let recordings = ProjectRecordings::new(meta);

    ffmpeg::init().unwrap();

    let start_time = Instant::now();

    // Get the duration from the timeline if it exists, otherwise use the longest source duration
    let duration = get_duration(&recordings, meta, &project);

    let total_frames = (fps as f64 * duration).ceil() as u32;
    println!(
        "Final export duration: {} seconds ({} frames at {}fps)",
        duration, total_frames, fps
    );

    let mut frame_number = 0;
    let background = Background::from(project.background.source.clone());

    let mut frame_renderer = FrameRenderer::new(&constants);

    loop {
        if frame_number >= total_frames {
            break;
        }

        let Some((segment_time, segment_i)) =
            project.get_segment_time(frame_number as f64 / fps as f64)
        else {
            break;
        };

        let segment = &segments[segment_i as usize];

        // do this after all usages but before any 'continue' to handle frame skip
        let frame_number = {
            let prev = frame_number;
            std::mem::replace(&mut frame_number, prev + 1)
        };

        if let Some(segment_frames) = segment
            .decoders
            .get_frames(segment_time as f32, !project.camera.hide)
            .await
        {
            let uniforms = ProjectUniforms::new(
                &constants,
                &project,
                frame_number,
                fps,
                resolution_base,
                is_upgraded,
            );
            let frame = frame_renderer
                .render(
                    segment_frames,
                    background.clone(),
                    &uniforms,
                    resolution_base,
                )
                .await?;

            if frame.width == 0 || frame.height == 0 {
                continue;
            }

            sender.send((frame, frame_number)).await?;
        }
    }

    let total_time = start_time.elapsed();
    println!(
        "Render complete. Processed {frame_number} frames in {:?} seconds",
        total_time.as_secs_f32()
    );

    Ok(())
}

pub fn get_duration(
    recordings: &ProjectRecordings,
    meta: &RecordingMeta,
    project: &ProjectConfiguration,
) -> f64 {
    let mut max_duration = recordings.duration();
    println!("Initial screen recording duration: {}", max_duration);

    // Check camera duration if it exists
    if let Some(camera_path) = meta.content.camera_path() {
        if let Ok(camera_duration) =
            recordings.get_source_duration(&camera_path.to_path(&meta.project_path))
        {
            println!("Camera recording duration: {}", camera_duration);
            max_duration = max_duration.max(camera_duration);
            println!("New max duration after camera check: {}", max_duration);
        }
    }

    // If there's a timeline, ensure all segments extend to the max duration
    if let Some(timeline) = &project.timeline {
        println!("Found timeline with {} segments", timeline.segments.len());
        // for (i, segment) in timeline.segments.iter().enumerate() {
        //     println!(
        //         "Segment {} - current end: {}, max_duration: {}",
        //         i, segment.end, max_duration
        //     );
        //     if segment.end < max_duration {
        //         segment.end = max_duration;
        //         println!("Extended segment {} to new end: {}", i, segment.end);
        //     }
        // }
        let final_duration = timeline.duration();
        println!(
            "Final timeline duration after adjustments: {}",
            final_duration
        );
        final_duration
    } else {
        println!("No timeline found, using max_duration: {}", max_duration);
        max_duration
    }
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
    image_background_pipeline: ImageBackgroundPipeline,
    background_textures: std::sync::Arc<tokio::sync::RwLock<HashMap<String, wgpu::Texture>>>,
    screen_frame: (wgpu::Texture, wgpu::TextureView),
    camera_frame: Option<(wgpu::Texture, wgpu::TextureView)>,
    pub background_blur_pipeline: BackgroundBlurPipeline,
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

        let cursor_textures = Self::load_cursor_textures(&device, &queue, meta);
        let cursor_pipeline = CursorPipeline::new(&device);
        let composite_video_frame_pipeline = CompositeVideoFramePipeline::new(&device);
        let gradient_or_color_pipeline = GradientOrColorPipeline::new(&device);

        let image_background_pipeline = ImageBackgroundPipeline::new(&device);
        let background_textures = Arc::new(tokio::sync::RwLock::new(HashMap::new()));

        let background_blur_pipeline = BackgroundBlurPipeline::new(&device);

        let screen_frame = {
            let texture = device.create_texture(
                &(wgpu::TextureDescriptor {
                    size: wgpu::Extent3d {
                        width: options.screen_size.x,
                        height: options.screen_size.y,
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

            (texture, texture_view)
        };

        let camera_frame = options.camera_size.map(|s| {
            let texture = device.create_texture(
                &(wgpu::TextureDescriptor {
                    size: wgpu::Extent3d {
                        width: s.x,
                        height: s.y,
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

            (texture, texture_view)
        });

        Ok(Self {
            _instance: instance,
            _adapter: adapter,
            device,
            queue,
            options,
            composite_video_frame_pipeline,
            gradient_or_color_pipeline,
            cursor_textures,
            cursor_pipeline,
            image_background_pipeline,
            background_textures,
            screen_frame,
            camera_frame,
            background_blur_pipeline,
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
    pub project: ProjectConfiguration,
    pub is_upgraded: bool,
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
        project.background.crop.as_ref().cloned().unwrap_or(Crop {
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

    pub fn get_output_size(
        options: &RenderOptions,
        project: &ProjectConfiguration,
        resolution_base: XY<u32>,
    ) -> (u32, u32) {
        let crop = Self::get_crop(options, project);
        let crop_aspect = crop.aspect_ratio();
        let padding = Self::get_padding(options, project) * 2.0;

        let (base_width, base_height) = match &project.aspect_ratio {
            None => {
                let width = ((crop.size.x as f64 + padding) as u32 + 1) & !1;
                let height = ((crop.size.y as f64 + padding) as u32 + 1) & !1;
                (width, height)
            }
            Some(AspectRatio::Square) => {
                let size = if crop_aspect > 1.0 {
                    crop.size.y
                } else {
                    crop.size.x
                };
                (size, size)
            }
            Some(AspectRatio::Wide) => {
                if crop_aspect > 16.0 / 9.0 {
                    (((crop.size.y as f32 * 16.0 / 9.0) as u32), crop.size.y)
                } else {
                    (crop.size.x, ((crop.size.x as f32 * 9.0 / 16.0) as u32))
                }
            }
            Some(AspectRatio::Vertical) => {
                if crop_aspect > 9.0 / 16.0 {
                    ((crop.size.y as f32 * 9.0 / 16.0) as u32, crop.size.y)
                } else {
                    (crop.size.x, ((crop.size.x as f32 * 16.0 / 9.0) as u32))
                }
            }
            Some(AspectRatio::Classic) => {
                if crop_aspect > 4.0 / 3.0 {
                    ((crop.size.y as f32 * 4.0 / 3.0) as u32, crop.size.y)
                } else {
                    (crop.size.x, ((crop.size.x as f32 * 3.0 / 4.0) as u32))
                }
            }
            Some(AspectRatio::Tall) => {
                if crop_aspect > 3.0 / 4.0 {
                    ((crop.size.y as f32 * 3.0 / 4.0) as u32, crop.size.y)
                } else {
                    (crop.size.x, ((crop.size.x as f32 * 4.0 / 3.0) as u32))
                }
            }
        };

        let width_scale = resolution_base.x as f32 / base_width as f32;
        let height_scale = resolution_base.y as f32 / base_height as f32;
        let scale = width_scale.min(height_scale);

        let scaled_width = ((base_width as f32 * scale) as u32 + 1) & !1;
        let scaled_height = ((base_height as f32 * scale) as u32 + 1) & !1;
        return (scaled_width, scaled_height);

        // ((base_width + 1) & !1, (base_height + 1) & !1)
    }

    pub fn get_display_offset(
        options: &RenderOptions,
        project: &ProjectConfiguration,
        resolution_base: XY<u32>,
    ) -> Coord<FrameSpace> {
        let output_size = Self::get_output_size(options, project, resolution_base);
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
        frame_number: u32,
        fps: u32,
        resolution_base: XY<u32>,
        is_upgraded: bool,
    ) -> Self {
        let options = &constants.options;
        let output_size = Self::get_output_size(options, project, resolution_base);
        let frame_time = frame_number as f32 / fps as f32;

        let cursor_position = interpolate_cursor_position(
            &Default::default(), /*constants.cursor*/
            frame_time,
            &project.cursor.animation_style,
        );

        // let zoom_keyframes = ZoomKeyframes::new(project);
        // let current_zoom = zoom_keyframes.interpolate(time as f64);
        // let prev_zoom = zoom_keyframes.interpolate((time - 1.0 / 30.0) as f64);

        let velocity = [0.0, 0.0];
        // if current_zoom.amount != prev_zoom.amount {
        //     let scale_change = (current_zoom.amount - prev_zoom.amount) as f32;
        //     // Reduce the velocity scale from 0.05 to 0.02
        //     [
        //         (scale_change * output_size.0 as f32) * 0.02, // Reduced from 0.05
        //         (scale_change * output_size.1 as f32) * 0.02,
        //     ]
        // } else {
        //     [0.0, 0.0]
        // };

        let motion_blur_amount = 0.0;
        // if current_zoom.amount != prev_zoom.amount {
        //     project.motion_blur.unwrap_or(0.2) // Reduced from 0.5 to 0.2
        // } else {
        //     0.0
        // };

        let crop = Self::get_crop(options, project);

        let segment_cursor = SegmentsCursor::new(
            frame_time as f64,
            project
                .timeline
                .as_ref()
                .map(|t| t.zoom_segments.as_slice())
                .unwrap_or(&[]),
        );

        let zoom = InterpolatedZoom::new(segment_cursor);

        let display = {
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

            let display_offset = Self::get_display_offset(options, project, resolution_base);

            let end = Coord::new(output_size) - display_offset;

            let target_size = end - display_offset;

            let (zoom_start, zoom_end) = (
                Coord::new(zoom.bounds.top_left * target_size.coord),
                Coord::new((zoom.bounds.bottom_right - 1.0) * target_size.coord),
            );

            let start = display_offset + zoom_start;
            let end = end + zoom_end;

            let target_size = end - start;
            let min_target_axis = target_size.x.min(target_size.y);

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
                rounding_px: (project.background.rounding / 100.0 * 0.5 * min_target_axis) as f32,
                mirror_x: 0.0,
                velocity_uv: velocity,
                motion_blur_amount,
                camera_motion_blur_amount: 0.0,
                shadow: project.background.shadow,
                shadow_size: project
                    .background
                    .advanced_shadow
                    .as_ref()
                    .map_or(50.0, |s| s.size),
                shadow_opacity: project
                    .background
                    .advanced_shadow
                    .as_ref()
                    .map_or(18.0, |s| s.opacity),
                shadow_blur: project
                    .background
                    .advanced_shadow
                    .as_ref()
                    .map_or(50.0, |s| s.blur),
                _padding: [0.0; 3],
            }
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
                let zoom_size = project.camera.zoom_size.unwrap_or(60.0) / 100.0;

                let zoomed_size =
                    (zoom.t as f32) * zoom_size * base_size + (1.0 - zoom.t as f32) * base_size;

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
                let camera_motion_blur = 0.0;

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
                    shadow: project.camera.shadow,
                    shadow_size: project
                        .camera
                        .advanced_shadow
                        .as_ref()
                        .map_or(50.0, |s| s.size),
                    shadow_opacity: project
                        .camera
                        .advanced_shadow
                        .as_ref()
                        .map_or(18.0, |s| s.opacity),
                    shadow_blur: project
                        .camera
                        .advanced_shadow
                        .as_ref()
                        .map_or(50.0, |s| s.blur),
                    _padding: [0.0; 3],
                }
            });

        Self {
            output_size,
            cursor_size: project.cursor.size as f32,
            display,
            camera,
            project: project.clone(),
            is_upgraded,
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

pub struct DecodedSegmentFrames {
    pub screen_frame: DecodedFrame,
    pub camera_frame: Option<DecodedFrame>,
    pub segment_time: f32,
}

pub struct FrameRenderer<'a> {
    constants: &'a RenderVideoConstants,
    output_texture_desc: Option<wgpu::TextureDescriptor<'static>>,
    output_textures: Option<(wgpu::Texture, wgpu::Texture)>,
}

impl<'a> FrameRenderer<'a> {
    pub fn new(constants: &'a RenderVideoConstants) -> Self {
        Self {
            constants,
            output_texture_desc: None,
            output_textures: None,
        }
    }

    fn update_output_textures(&mut self, width: u32, height: u32) {
        if let Some(desc) = &self.output_texture_desc {
            if desc.size.width == width && desc.size.height == height {
                return;
            }
        }

        let output_texture_desc = self.output_texture_desc.insert(wgpu::TextureDescriptor {
            size: wgpu::Extent3d {
                width,
                height,
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
        });

        self.output_textures = Some((
            self.constants.device.create_texture(output_texture_desc),
            self.constants.device.create_texture(output_texture_desc),
        ));
    }

    pub async fn render(
        &mut self,
        segment_frames: DecodedSegmentFrames,
        background: Background,
        uniforms: &ProjectUniforms,
        resolution_base: XY<u32>,
    ) -> Result<RenderedFrame, RenderingError> {
        self.update_output_textures(uniforms.output_size.0, uniforms.output_size.1);

        produce_frame(
            &self.constants,
            segment_frames,
            background,
            uniforms,
            resolution_base,
            self.output_textures.as_ref().unwrap(),
        )
        .await
    }
}

async fn produce_frame(
    constants: &RenderVideoConstants,
    segment_frames: DecodedSegmentFrames,
    background: Background,
    uniforms: &ProjectUniforms,
    resolution_base: XY<u32>,
    textures: &(wgpu::Texture, wgpu::Texture),
) -> Result<RenderedFrame, RenderingError> {
    let mut pipeline = FramePipelineState::new(constants, uniforms, textures);
    let mut encoder = FramePipelineEncoder::new(&pipeline);

    BackgroundLayer::new(&mut pipeline, &mut encoder)
        .render(background)
        .await?;

    DisplayLayer::new(&mut pipeline, &mut encoder).render(&segment_frames);

    CursorLayer::new(&mut pipeline, &mut encoder).render(&segment_frames, resolution_base);

    // camera
    if let (Some(camera_size), Some(camera_frame), Some(uniforms), Some((texture, texture_view))) = (
        constants.options.camera_size,
        &segment_frames.camera_frame,
        &uniforms.camera,
        &constants.camera_frame,
    ) {
        CameraLayer::new(&mut pipeline, &mut encoder).render(
            camera_size,
            camera_frame,
            uniforms,
            (texture, texture_view),
        );
    }

    let padded_bytes_per_row = encoder.padded_bytes_per_row(&pipeline);
    let image_data = encoder.copy_output(pipeline).await?;

    Ok(RenderedFrame {
        data: image_data,
        padded_bytes_per_row,
        width: uniforms.output_size.0,
        height: uniforms.output_size.1,
    })
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
    pub shadow: f32,
    pub shadow_size: f32,
    pub shadow_opacity: f32,
    pub shadow_blur: f32,
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
        let render_pipeline = create_shader_render_pipeline(
            device,
            &bind_group_layout,
            include_wgsl!("shaders/composite-video-frame.wgsl"),
        );

        Self {
            bind_group_layout,
            render_pipeline,
        }
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

pub fn create_shader_render_pipeline(
    device: &wgpu::Device,
    bind_group_layout: &wgpu::BindGroupLayout,
    shader: wgpu::ShaderModuleDescriptor,
) -> wgpu::RenderPipeline {
    let shader = device.create_shader_module(shader);

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
