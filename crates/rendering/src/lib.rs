use anyhow::Result;
use cap_project::{
    AspectRatio, CameraXPosition, CameraYPosition, Crop, CursorEvents, ProjectConfiguration,
    RecordingMeta, StudioRecordingMeta, XY,
};
use composite_frame::{CompositeVideoFramePipeline, CompositeVideoFrameUniforms};
use core::f64;
use cursor_interpolation::{interpolate_cursor, InterpolatedCursorPosition};
use decoder::{spawn_decoder, AsyncVideoDecoderHandle};
use frame_pipeline::finish_encoder;
use futures::future::OptionFuture;
use futures::FutureExt;
use layers::{
    Background, BackgroundLayer, BlurLayer, CameraLayer, CursorLayer, DisplayLayer,
    GradientOrColorPipeline, ImageBackgroundPipeline,
};
use specta::Type;
use spring_mass_damper::SpringMassDamperSimulationConfig;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::mpsc;
use tracing::subscriber::DefaultGuard;

use image::GenericImageView;
use std::{path::PathBuf, time::Instant};

mod composite_frame;
mod coord;
mod cursor_interpolation;
pub mod decoder;
mod frame_pipeline;
mod layers;
mod project_recordings;
mod spring_mass_damper;
mod zoom;

pub use coord::*;
pub use decoder::DecodedFrame;
pub use frame_pipeline::RenderedFrame;
pub use project_recordings::{ProjectRecordings, SegmentRecordings, Video};

use zoom::*;

const STANDARD_CURSOR_HEIGHT: f32 = 75.0;

#[derive(Debug, Clone, Copy, Type)]
pub struct RenderOptions {
    pub camera_size: Option<XY<u32>>,
    pub screen_size: XY<u32>,
}

#[derive(Clone)]
pub struct RecordingSegmentDecoders {
    screen: AsyncVideoDecoderHandle,
    camera: Option<AsyncVideoDecoderHandle>,
    pub segment_offset: f64,
}

pub struct SegmentVideoPaths {
    pub display: PathBuf,
    pub camera: Option<PathBuf>,
}

impl RecordingSegmentDecoders {
    pub async fn new(
        recording_meta: &RecordingMeta,
        meta: &StudioRecordingMeta,
        segment: SegmentVideoPaths,
        segment_i: usize,
    ) -> Result<Self, String> {
        let latest_start_time = match &meta {
            StudioRecordingMeta::SingleSegment { .. } => None,
            StudioRecordingMeta::MultipleSegments { inner, .. } => {
                inner.segments[segment_i].latest_start_time()
            }
        };

        let screen = spawn_decoder(
            "screen",
            recording_meta.project_path.join(segment.display),
            match &meta {
                StudioRecordingMeta::SingleSegment { segment } => segment.display.fps,
                StudioRecordingMeta::MultipleSegments { inner, .. } => {
                    inner.segments[segment_i].display.fps
                }
            },
            match &meta {
                StudioRecordingMeta::SingleSegment { .. } => 0.0,
                StudioRecordingMeta::MultipleSegments { inner, .. } => {
                    let segment = &inner.segments[segment_i];

                    latest_start_time
                        .zip(segment.display.start_time)
                        .map(|(latest_start_time, display_time)| latest_start_time - display_time)
                        .unwrap_or(0.0)
                }
            },
        )
        .await
        .map_err(|e| format!("Screen:{e}"))?;
        let camera = OptionFuture::from(segment.camera.map(|camera| {
            spawn_decoder(
                "camera",
                recording_meta.project_path.join(camera),
                match &meta {
                    StudioRecordingMeta::SingleSegment { segment } => {
                        segment.camera.as_ref().unwrap().fps
                    }
                    StudioRecordingMeta::MultipleSegments { inner, .. } => {
                        inner.segments[0].camera.as_ref().unwrap().fps
                    }
                },
                match &meta {
                    StudioRecordingMeta::SingleSegment { .. } => 0.0,
                    StudioRecordingMeta::MultipleSegments { inner, .. } => {
                        let segment = &inner.segments[segment_i];

                        latest_start_time
                            .zip(segment.camera.as_ref().and_then(|c| c.start_time))
                            .map(|(latest_start_time, start_time)| latest_start_time - start_time)
                            .unwrap_or(0.0)
                    }
                },
            )
            .then(|r| async { r.map_err(|e| format!("Camera:{e}")) })
        }))
        .await
        .transpose()?;

        Ok(Self {
            screen,
            camera,
            segment_offset: latest_start_time.unwrap_or(0.0),
        })
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
            recording_time: segment_time + self.segment_offset as f32,
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

#[derive(Clone)]
pub struct RenderSegment {
    pub cursor: Arc<CursorEvents>,
    pub decoders: RecordingSegmentDecoders,
}

pub async fn render_video_to_channel(
    options: RenderOptions,
    project: ProjectConfiguration,
    sender: mpsc::Sender<(RenderedFrame, u32)>,
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    segments: Vec<RenderSegment>,
    fps: u32,
    resolution_base: XY<u32>,
    recordings: &ProjectRecordings,
) -> Result<(), RenderingError> {
    use futures::stream::{FuturesUnordered, StreamExt};
    use std::sync::Arc;

    let constants = Arc::new(RenderVideoConstants::new(options, recording_meta, meta).await?);

    ffmpeg::init().unwrap();

    let start_time = Instant::now();

    // Get the duration from the timeline if it exists, otherwise use the longest source duration
    let duration = get_duration(recordings, recording_meta, meta, &project);

    let total_frames = (fps as f64 * duration).ceil() as u32;
    println!(
        "Final export duration: {} seconds ({} frames at {}fps)",
        duration, total_frames, fps
    );

    let segments = Arc::new(segments);
    let project = Arc::new(project);

    let concurrency = num_cpus::get();
    let mut in_flight: FuturesUnordered<_> = FuturesUnordered::new();
    let mut next_frame = 0;

    while next_frame < total_frames || !in_flight.is_empty() {
        while next_frame < total_frames && in_flight.len() < concurrency {
            let frame_no = next_frame;
            next_frame += 1;

            let constants = constants.clone();
            let project = project.clone();
            let segments = segments.clone();
            let sender = sender.clone();

            in_flight.push(tokio::spawn(async move {
                if let Some((segment_time, segment_i)) =
                    project.get_segment_time(frame_no as f64 / fps as f64)
                {
                    let segment = &segments[segment_i as usize];
                    if let Some(segment_frames) = segment
                        .decoders
                        .get_frames(segment_time as f32, !project.camera.hide)
                        .await
                    {
                        let uniforms = ProjectUniforms::new(
                            &constants,
                            &project,
                            frame_no,
                            fps,
                            resolution_base,
                            &segment.cursor,
                            &segment_frames,
                        );

                        let mut frame_renderer = FrameRenderer::new(&constants);
                        let mut layers = RendererLayers::new(&constants.device);

                        let frame = frame_renderer
                            .render(segment_frames, uniforms, &segment.cursor, &mut layers)
                            .await?;

                        if frame.width != 0 && frame.height != 0 {
                            sender
                                .send((frame, frame_no))
                                .await
                                .map_err(RenderingError::ChannelSendFrameFailed)?;
                        }
                    }
                }

                Ok::<(), RenderingError>(())
            }));
        }

        if let Some(res) = in_flight.next().await {
            res??;
        }
    }

    let total_time = start_time.elapsed();
    println!(
        "Render complete. Processed {total_frames} frames in {:?} seconds",
        total_time.as_secs_f32()
    );

    Ok(())
}

pub fn get_duration(
    recordings: &ProjectRecordings,
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    project: &ProjectConfiguration,
) -> f64 {
    let mut max_duration = recordings.duration();
    println!("Initial screen recording duration: {}", max_duration);

    // Check camera duration if it exists
    if let Some(camera_path) = meta.camera_path() {
        if let Ok(camera_duration) =
            recordings.get_source_duration(&recording_meta.path(&camera_path))
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

pub struct CursorTexture {
    inner: wgpu::Texture,
    hotspot: XY<f32>,
}

pub struct RenderVideoConstants {
    pub _instance: wgpu::Instance,
    pub _adapter: wgpu::Adapter,
    pub queue: wgpu::Queue,
    pub device: wgpu::Device,
    pub options: RenderOptions,
    pub cursor_textures: HashMap<String, CursorTexture>,
    background_textures: std::sync::Arc<tokio::sync::RwLock<HashMap<String, wgpu::Texture>>>,
    camera_frame: Option<(wgpu::Texture, wgpu::TextureView)>,
}

impl RenderVideoConstants {
    pub async fn new(
        options: RenderOptions,
        recording_meta: &RecordingMeta,
        meta: &StudioRecordingMeta,
    ) -> Result<Self, RenderingError> {
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

        let cursor_textures = Self::load_cursor_textures(&device, &queue, recording_meta, meta);
        let composite_video_frame_pipeline = CompositeVideoFramePipeline::new(&device);
        let gradient_or_color_pipeline = GradientOrColorPipeline::new(&device);

        let image_background_pipeline = ImageBackgroundPipeline::new(&device);
        let background_textures = Arc::new(tokio::sync::RwLock::new(HashMap::new()));

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
            cursor_textures,
            background_textures,
            camera_frame,
        })
    }

    fn load_cursor_textures(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        recording_meta: &RecordingMeta,
        meta: &StudioRecordingMeta,
    ) -> HashMap<String, CursorTexture> {
        let mut textures = HashMap::new();

        let cursor_images = match &meta {
            StudioRecordingMeta::SingleSegment { .. } => Default::default(),
            StudioRecordingMeta::MultipleSegments { inner, .. } => {
                inner.cursor_images(recording_meta).unwrap_or_default()
            }
        };

        for (cursor_id, cursor) in &cursor_images.0 {
            if !cursor.path.exists() {
                continue;
            }

            match image::open(&cursor.path) {
                Ok(img) => {
                    let dimensions = img.dimensions();

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

                    textures.insert(
                        cursor_id.clone(),
                        CursorTexture {
                            inner: texture,
                            hotspot: cursor.hotspot.map(|v| v as f32),
                        },
                    );
                    println!("Successfully loaded cursor texture: {}", cursor_id);
                }
                Err(e) => {
                    println!(
                        "Failed to load cursor image {}: {}",
                        cursor.path.display(),
                        e
                    );
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
    interpolated_cursor: Option<InterpolatedCursorPosition>,
    pub project: ProjectConfiguration,
    pub zoom: InterpolatedZoom,
    pub resolution_base: XY<u32>,
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

    pub fn display_offset(
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

    pub fn display_size(
        options: &RenderOptions,
        project: &ProjectConfiguration,
        resolution_base: XY<u32>,
    ) -> Coord<FrameSpace> {
        let output_size = Self::get_output_size(options, project, resolution_base);
        let output_size = XY::new(output_size.0 as f64, output_size.1 as f64);

        let display_offset = Self::display_offset(options, project, resolution_base);

        let end = Coord::new(output_size) - display_offset;

        end - display_offset
    }

    pub fn new(
        constants: &RenderVideoConstants,
        project: &ProjectConfiguration,
        frame_number: u32,
        fps: u32,
        resolution_base: XY<u32>,
        cursor_events: &CursorEvents,
        segment_frames: &DecodedSegmentFrames,
    ) -> Self {
        let options = &constants.options;
        let output_size = Self::get_output_size(options, project, resolution_base);
        let frame_time = frame_number as f32 / fps as f32;

        let velocity = [0.0, 0.0];

        let motion_blur_amount = 0.0;

        let crop = Self::get_crop(options, project);

        let interpolated_cursor = interpolate_cursor(
            cursor_events,
            segment_frames.recording_time,
            (!project.cursor.raw).then(|| SpringMassDamperSimulationConfig {
                tension: project.cursor.tension,
                mass: project.cursor.mass,
                friction: project.cursor.friction,
            }),
        );

        let zoom = InterpolatedZoom::new(
            SegmentsCursor::new(
                frame_time as f64,
                project
                    .timeline
                    .as_ref()
                    .map(|t| t.zoom_segments.as_slice())
                    .unwrap_or(&[]),
            ),
            interpolate_cursor(
                cursor_events,
                (segment_frames.recording_time - 0.2).max(0.0),
                (!project.cursor.raw).then(|| SpringMassDamperSimulationConfig {
                    tension: project.cursor.tension,
                    mass: project.cursor.mass,
                    friction: project.cursor.friction,
                }),
            )
            .as_ref()
            .map(|i| i.position)
            .unwrap_or_else(|| Coord::new(XY::new(0.5, 0.5))),
        );

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

            let display_offset = Self::display_offset(options, project, resolution_base);
            let display_size = Self::display_size(options, project, resolution_base);

            let end = Coord::new(output_size) - display_offset;

            let (zoom_start, zoom_end) = (
                Coord::new(zoom.bounds.top_left * display_size.coord),
                Coord::new((zoom.bounds.bottom_right - 1.0) * display_size.coord),
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
                let zoom_size = project
                    .camera
                    .zoom_size
                    .unwrap_or(cap_project::Camera::default_zoom_size())
                    / 100.0;

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
            resolution_base,
            display,
            camera,
            project: project.clone(),
            zoom,
            interpolated_cursor,
        }
    }
}

pub struct DecodedSegmentFrames {
    pub screen_frame: DecodedFrame,
    pub camera_frame: Option<DecodedFrame>,
    pub segment_time: f32,
    pub recording_time: f32,
}

pub struct FrameRenderer<'a> {
    constants: &'a RenderVideoConstants,
    session: Option<RenderSession>,
}

impl<'a> FrameRenderer<'a> {
    pub fn new(constants: &'a RenderVideoConstants) -> Self {
        Self {
            constants,
            session: None,
        }
    }

    pub async fn render(
        &mut self,
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        cursor: &CursorEvents,
        layers: &mut RendererLayers,
    ) -> Result<RenderedFrame, RenderingError> {
        let session = self.session.get_or_insert_with(|| {
            RenderSession::new(
                &self.constants.device,
                uniforms.output_size.0,
                uniforms.output_size.1,
            )
        });

        session.update_texture_size(
            &self.constants.device,
            uniforms.output_size.0,
            uniforms.output_size.1,
        );

        produce_frame(
            &self.constants,
            segment_frames,
            uniforms,
            cursor,
            layers,
            session,
        )
        .await
    }
}

pub struct RendererLayers {
    background: BackgroundLayer,
    background_blur: BlurLayer,
    display: DisplayLayer,
    cursor: CursorLayer,
    camera: CameraLayer,
}

impl RendererLayers {
    pub fn new(device: &wgpu::Device) -> Self {
        Self {
            background: BackgroundLayer::new(device),
            background_blur: BlurLayer::new(device),
            display: DisplayLayer::new(device),
            cursor: CursorLayer::new(device),
            camera: CameraLayer::new(device),
        }
    }

    pub async fn prepare(
        &mut self,
        constants: &RenderVideoConstants,
        uniforms: &ProjectUniforms,
        segment_frames: &DecodedSegmentFrames,
        cursor: &CursorEvents,
    ) -> Result<(), RenderingError> {
        self.background
            .prepare(
                &constants,
                uniforms,
                Background::from(uniforms.project.background.source.clone()),
            )
            .await?;

        if uniforms.project.background.blur > 0.0 {
            self.background_blur.prepare(&constants.queue, uniforms);
        }

        self.display.prepare(
            &constants.device,
            &constants.queue,
            segment_frames,
            constants.options.screen_size,
            &uniforms,
        );

        self.cursor.prepare(
            segment_frames,
            uniforms.resolution_base,
            cursor,
            &uniforms.zoom,
            uniforms,
            constants,
        );

        if let (
            Some(camera_size),
            Some(camera_frame),
            Some(uniforms),
            Some((texture, texture_view)),
        ) = (
            constants.options.camera_size,
            &segment_frames.camera_frame,
            &uniforms.camera,
            &constants.camera_frame,
        ) {
            self.camera.prepare(
                &constants.device,
                &constants.queue,
                *uniforms,
                camera_size,
                camera_frame,
                (texture, texture_view),
            );
        }

        Ok(())
    }

    pub fn render(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        session: &mut RenderSession,
    ) {
        macro_rules! render_pass {
            ($view:expr, $load:expr) => {
                encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Render Pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: $view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: $load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                })
            };
        }

        {
            let mut pass = render_pass!(
                session.current_texture_view(),
                wgpu::LoadOp::Clear(wgpu::Color::BLACK)
            );
            self.background.render(&mut pass);
        }

        if self.background_blur.blur_amount > 0.0 {
            let mut pass = render_pass!(session.other_texture_view(), wgpu::LoadOp::Load);
            self.background_blur
                .render(&mut pass, device, session.current_texture_view());

            session.swap_textures();
        }

        {
            let mut pass = render_pass!(session.current_texture_view(), wgpu::LoadOp::Load);
            self.display.render(&mut pass);
        }

        {
            let mut pass = render_pass!(session.current_texture_view(), wgpu::LoadOp::Load);
            self.cursor.render(&mut pass);
        }

        {
            let mut pass = render_pass!(session.current_texture_view(), wgpu::LoadOp::Load);
            self.camera.render(&mut pass);
        }
    }
}

pub struct RenderSession {
    textures: (wgpu::Texture, wgpu::Texture),
    texture_views: (wgpu::TextureView, wgpu::TextureView),
    current_is_left: bool,
}

impl RenderSession {
    pub fn new(device: &wgpu::Device, width: u32, height: u32) -> Self {
        let make_texture = || {
            device.create_texture(&wgpu::TextureDescriptor {
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
            })
        };

        let textures = (make_texture(), make_texture());

        Self {
            current_is_left: true,
            texture_views: (
                textures.0.create_view(&Default::default()),
                textures.1.create_view(&Default::default()),
            ),
            textures,
        }
    }

    pub fn update_texture_size(&mut self, device: &wgpu::Device, width: u32, height: u32) {
        let make_texture = || {
            device.create_texture(&wgpu::TextureDescriptor {
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
            })
        };

        self.textures = (make_texture(), make_texture());
        self.texture_views = (
            self.textures.0.create_view(&Default::default()),
            self.textures.1.create_view(&Default::default()),
        );
    }

    pub fn current_texture(&self) -> &wgpu::Texture {
        if self.current_is_left {
            &self.textures.0
        } else {
            &self.textures.1
        }
    }

    pub fn current_texture_view(&self) -> &wgpu::TextureView {
        if self.current_is_left {
            &self.texture_views.0
        } else {
            &self.texture_views.1
        }
    }

    pub fn other_texture_view(&self) -> &wgpu::TextureView {
        if self.current_is_left {
            &self.texture_views.1
        } else {
            &self.texture_views.0
        }
    }

    pub fn swap_textures(&mut self) {
        self.current_is_left = !self.current_is_left;
    }
}

// TODO: reuse as many resources as possible
// https://github.com/gfx-rs/wgpu/wiki/Encapsulating-Graphics-Work
async fn produce_frame(
    constants: &RenderVideoConstants,
    segment_frames: DecodedSegmentFrames,
    uniforms: ProjectUniforms,
    cursor: &CursorEvents,
    layers: &mut RendererLayers,
    session: &mut RenderSession,
) -> Result<RenderedFrame, RenderingError> {
    layers
        .prepare(constants, &uniforms, &segment_frames, cursor)
        .await?;

    let mut encoder = constants.device.create_command_encoder(
        &(wgpu::CommandEncoderDescriptor {
            label: Some("Render Encoder"),
        }),
    );

    layers.render(&constants.device, &mut encoder, session);

    Ok(finish_encoder(
        session,
        &constants.device,
        &constants.queue,
        &uniforms,
        encoder,
    )
    .await?)
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
                blend: Some(wgpu::BlendState::ALPHA_BLENDING),
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
