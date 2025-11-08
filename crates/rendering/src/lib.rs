use anyhow::Result;
use cap_project::{
    AspectRatio, CameraShape, CameraXPosition, CameraYPosition, ClipOffsets, Crop, CursorEvents,
    ProjectConfiguration, RecordingMeta, StudioRecordingMeta, XY,
};
use composite_frame::CompositeVideoFrameUniforms;
use core::f64;
use cursor_interpolation::{InterpolatedCursorPosition, interpolate_cursor};
use decoder::{AsyncVideoDecoderHandle, spawn_decoder};
use frame_pipeline::finish_encoder;
use futures::FutureExt;
use futures::future::OptionFuture;
use layers::{
    Background, BackgroundLayer, BlurLayer, CameraLayer, CaptionsLayer, CursorLayer, DisplayLayer,
};
use specta::Type;
use spring_mass_damper::SpringMassDamperSimulationConfig;
use std::{collections::HashMap, sync::Arc};
use std::{path::PathBuf, time::Instant};
use tokio::sync::mpsc;
use tracing::error;

mod composite_frame;
mod coord;
mod cursor_interpolation;
pub mod decoder;
mod frame_pipeline;
mod layers;
mod project_recordings;
mod scene;
mod spring_mass_damper;
mod zoom;

pub use coord::*;
pub use decoder::DecodedFrame;
pub use frame_pipeline::RenderedFrame;
pub use project_recordings::{ProjectRecordingsMeta, SegmentRecordings};

use scene::*;
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
        offsets: ClipOffsets,
    ) -> Option<DecodedSegmentFrames> {
        let (screen, camera) = tokio::join!(
            self.screen.get_frame(segment_time),
            OptionFuture::from(
                needs_camera
                    .then(|| self
                        .camera
                        .as_ref()
                        .map(|d| d.get_frame(segment_time + offsets.camera)))
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
    #[error("Error polling wgpu: {0}")]
    PollError(#[from] wgpu::PollError),
}

pub struct RenderSegment {
    pub cursor: Arc<CursorEvents>,
    pub decoders: RecordingSegmentDecoders,
}

#[allow(clippy::too_many_arguments)]
pub async fn render_video_to_channel(
    constants: &RenderVideoConstants,
    project: &ProjectConfiguration,
    sender: mpsc::Sender<(RenderedFrame, u32)>,
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    render_segments: Vec<RenderSegment>,
    fps: u32,
    resolution_base: XY<u32>,
    recordings: &ProjectRecordingsMeta,
) -> Result<(), RenderingError> {
    ffmpeg::init().unwrap();

    let start_time = Instant::now();

    let duration = get_duration(recordings, recording_meta, meta, project);

    let total_frames = (fps as f64 * duration).ceil() as u32;

    let mut frame_number = 0;

    let mut frame_renderer = FrameRenderer::new(constants);

    let mut layers = RendererLayers::new(&constants.device, &constants.queue);

    loop {
        if frame_number >= total_frames {
            break;
        }

        let Some((segment_time, segment)) =
            project.get_segment_time(frame_number as f64 / fps as f64)
        else {
            break;
        };

        let clip_config = project
            .clips
            .iter()
            .find(|v| v.index == segment.recording_clip);

        let frame_number = {
            let prev = frame_number;
            std::mem::replace(&mut frame_number, prev + 1)
        };

        let render_segment = &render_segments[segment.recording_clip as usize];

        if let Some(segment_frames) = render_segment
            .decoders
            .get_frames(
                segment_time as f32,
                !project.camera.hide,
                clip_config.map(|v| v.offsets).unwrap_or_default(),
            )
            .await
        {
            let uniforms = ProjectUniforms::new(
                constants,
                project,
                frame_number,
                fps,
                resolution_base,
                &render_segment.cursor,
                &segment_frames,
            );

            let frame = frame_renderer
                .render(
                    segment_frames,
                    uniforms,
                    &render_segment.cursor,
                    &mut layers,
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
    recordings: &ProjectRecordingsMeta,
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    project: &ProjectConfiguration,
) -> f64 {
    let mut max_duration = recordings.duration();

    if let Some(camera_path) = meta.camera_path()
        && let Ok(camera_duration) =
            recordings.get_source_duration(&recording_meta.path(&camera_path))
    {
        println!("Camera recording duration: {camera_duration}");
        max_duration = max_duration.max(camera_duration);
        println!("New max duration after camera check: {max_duration}");
    }

    if let Some(timeline) = &project.timeline {
        timeline.duration()
    } else {
        println!("No timeline found, using max_duration: {max_duration}");
        max_duration
    }
}

pub struct RenderVideoConstants {
    pub _instance: wgpu::Instance,
    pub _adapter: wgpu::Adapter,
    pub queue: wgpu::Queue,
    pub device: wgpu::Device,
    pub options: RenderOptions,
    pub meta: StudioRecordingMeta,
    pub recording_meta: RecordingMeta,
    pub background_textures: std::sync::Arc<tokio::sync::RwLock<HashMap<String, wgpu::Texture>>>,
}

impl RenderVideoConstants {
    pub async fn new(
        segments: &[SegmentRecordings],
        recording_meta: RecordingMeta,
        meta: StudioRecordingMeta,
    ) -> Result<Self, RenderingError> {
        let options = RenderOptions {
            screen_size: XY::new(segments[0].display.width, segments[0].display.height),
            camera_size: segments[0]
                .camera
                .as_ref()
                .map(|c| XY::new(c.width, c.height)),
        };

        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: None,
            })
            .await
            .map_err(|_| RenderingError::NoAdapter)?;

        let device_descriptor = wgpu::DeviceDescriptor {
            label: Some("cap-rendering-device"),
            required_features: wgpu::Features::empty(),
            ..Default::default()
        };

        let (device, queue) = adapter.request_device(&device_descriptor).await?;

        let background_textures = Arc::new(tokio::sync::RwLock::new(HashMap::new()));

        Ok(Self {
            _instance: instance,
            _adapter: adapter,
            device,
            queue,
            options,
            background_textures,
            meta,
            recording_meta,
        })
    }
}

#[derive(Clone, Debug)]
pub struct ProjectUniforms {
    pub output_size: (u32, u32),
    pub cursor_size: f32,
    display: CompositeVideoFrameUniforms,
    camera: Option<CompositeVideoFrameUniforms>,
    camera_only: Option<CompositeVideoFrameUniforms>,
    interpolated_cursor: Option<InterpolatedCursorPosition>,
    pub project: ProjectConfiguration,
    pub zoom: InterpolatedZoom,
    pub scene: InterpolatedScene,
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
    pub fn get_crop(options: &RenderOptions, project: &ProjectConfiguration) -> Crop {
        project.background.crop.as_ref().cloned().unwrap_or(Crop {
            position: XY { x: 0, y: 0 },
            size: XY {
                x: options.screen_size.x,
                y: options.screen_size.y,
            },
        })
    }

    #[allow(unused)]
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

        let (base_width, base_height) = match &project.aspect_ratio {
            None => {
                let padding_basis = u32::max(crop.size.x, crop.size.y) as f64;
                let padding =
                    padding_basis * project.background.padding / 100.0 * SCREEN_MAX_PADDING * 2.0;
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
        (scaled_width, scaled_height)
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

        let padding = {
            let padding_factor = project.background.padding / 100.0 * SCREEN_MAX_PADDING;

            f64::max(output_size.x, output_size.y) * padding_factor
        };

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

    fn auto_zoom_focus(
        cursor_events: &CursorEvents,
        time_secs: f32,
        smoothing: Option<SpringMassDamperSimulationConfig>,
        current_cursor: Option<InterpolatedCursorPosition>,
    ) -> Coord<RawDisplayUVSpace> {
        const PREVIOUS_SAMPLE_DELTA: f32 = 0.1;
        const MIN_LOOKAHEAD: f64 = 0.05;
        const MAX_LOOKAHEAD: f64 = 0.18;
        const MIN_FOLLOW_FACTOR: f64 = 0.2;
        const MAX_FOLLOW_FACTOR: f64 = 0.65;
        const SPEED_RESPONSE: f64 = 12.0;
        const VELOCITY_BLEND: f64 = 0.25;
        const MAX_SHIFT: f64 = 0.25;
        const MIN_SPEED: f64 = 0.002;

        let fallback = Coord::<RawDisplayUVSpace>::new(XY::new(0.5, 0.5));

        let current_cursor = match current_cursor
            .or_else(|| interpolate_cursor(cursor_events, time_secs, smoothing))
        {
            Some(cursor) => cursor,
            None => return fallback,
        };

        let previous_time = (time_secs - PREVIOUS_SAMPLE_DELTA).max(0.0);
        let previous_cursor = if previous_time < time_secs {
            interpolate_cursor(cursor_events, previous_time, smoothing)
        } else {
            None
        };

        let current_position = current_cursor.position.coord;
        let previous_position = previous_cursor
            .as_ref()
            .map(|c| c.position.coord)
            .unwrap_or(current_position);

        let delta_time = (time_secs - previous_time).max(f32::EPSILON) as f64;

        let simulation_velocity = XY::new(
            current_cursor.velocity.x as f64,
            current_cursor.velocity.y as f64,
        );

        let finite_velocity = if previous_cursor.is_some() {
            (current_position - previous_position) / delta_time
        } else {
            XY::new(0.0, 0.0)
        };

        let mut velocity = if smoothing.is_some() {
            simulation_velocity * (1.0 - VELOCITY_BLEND) + finite_velocity * VELOCITY_BLEND
        } else {
            finite_velocity
        };

        if velocity.x.is_nan() || velocity.y.is_nan() {
            velocity = XY::new(0.0, 0.0);
        }

        let speed = (velocity.x * velocity.x + velocity.y * velocity.y).sqrt();

        if speed < MIN_SPEED {
            return Coord::new(XY::new(
                current_position.x.clamp(0.0, 1.0),
                current_position.y.clamp(0.0, 1.0),
            ));
        }

        let speed_factor = (1.0 - (-speed / SPEED_RESPONSE).exp()).clamp(0.0, 1.0);

        let lookahead = MIN_LOOKAHEAD + (MAX_LOOKAHEAD - MIN_LOOKAHEAD) * speed_factor;
        let follow_strength =
            MIN_FOLLOW_FACTOR + (MAX_FOLLOW_FACTOR - MIN_FOLLOW_FACTOR) * speed_factor;

        let predicted_shift = XY::new(
            (velocity.x * lookahead).clamp(-MAX_SHIFT, MAX_SHIFT),
            (velocity.y * lookahead).clamp(-MAX_SHIFT, MAX_SHIFT),
        );

        let predicted_center = current_position + predicted_shift;
        let base_center = previous_cursor
            .map(|prev| {
                let retention = 0.45 + 0.25 * speed_factor;
                prev.position.coord * retention + current_position * (1.0 - retention)
            })
            .unwrap_or(current_position);

        let final_center =
            base_center * (1.0 - follow_strength) + predicted_center * follow_strength;

        Coord::new(XY::new(
            final_center.x.clamp(0.0, 1.0),
            final_center.y.clamp(0.0, 1.0),
        ))
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

        let cursor_smoothing = (!project.cursor.raw).then_some(SpringMassDamperSimulationConfig {
            tension: project.cursor.tension,
            mass: project.cursor.mass,
            friction: project.cursor.friction,
        });

        let interpolated_cursor = interpolate_cursor(
            cursor_events,
            segment_frames.recording_time,
            cursor_smoothing,
        );

        let zoom_focus = Self::auto_zoom_focus(
            cursor_events,
            segment_frames.recording_time,
            cursor_smoothing,
            interpolated_cursor.clone(),
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
            zoom_focus,
        );

        let scene = InterpolatedScene::new(SceneSegmentsCursor::new(
            frame_time as f64,
            project
                .timeline
                .as_ref()
                .map(|t| t.scene_segments.as_slice())
                .unwrap_or(&[]),
        ));

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
                motion_blur_amount: (motion_blur_amount + scene.screen_blur as f32 * 0.8).min(1.0),
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
                opacity: scene.screen_opacity as f32,
                border_enabled: if project
                    .background
                    .border
                    .as_ref()
                    .is_some_and(|b| b.enabled)
                {
                    1.0
                } else {
                    0.0
                },
                border_width: project.background.border.as_ref().map_or(5.0, |b| b.width),
                _padding0: 0.0,
                _padding1: [0.0; 2],
                _padding1b: [0.0; 2],
                border_color: if let Some(b) = project.background.border.as_ref() {
                    [
                        b.color[0] as f32 / 255.0,
                        b.color[1] as f32 / 255.0,
                        b.color[2] as f32 / 255.0,
                        (b.opacity / 100.0).clamp(0.0, 1.0),
                    ]
                } else {
                    [1.0, 1.0, 1.0, 0.8]
                },
                _padding2: [0.0; 4],
            }
        };

        let camera = options
            .camera_size
            .filter(|_| !project.camera.hide && scene.should_render_camera())
            .map(|camera_size| {
                let output_size = [output_size.0 as f32, output_size.1 as f32];
                let frame_size = [camera_size.x as f32, camera_size.y as f32];
                let min_axis = output_size[0].min(output_size[1]);

                let base_size = project.camera.size / 100.0;
                let zoom_size = project
                    .camera
                    .zoom_size
                    .unwrap_or(cap_project::Camera::default_zoom_size())
                    / 100.0;

                let zoomed_size =
                    (zoom.t as f32) * zoom_size * base_size + (1.0 - zoom.t as f32) * base_size;

                let zoomed_size = zoomed_size * scene.camera_scale as f32;

                let aspect = frame_size[0] / frame_size[1];
                let size = match project.camera.shape {
                    CameraShape::Source => {
                        if aspect >= 1.0 {
                            [
                                (min_axis * zoomed_size + CAMERA_PADDING) * aspect,
                                min_axis * zoomed_size + CAMERA_PADDING,
                            ]
                        } else {
                            [
                                min_axis * zoomed_size + CAMERA_PADDING,
                                (min_axis * zoomed_size + CAMERA_PADDING) / aspect,
                            ]
                        }
                    }
                    CameraShape::Square => [
                        min_axis * zoomed_size + CAMERA_PADDING,
                        min_axis * zoomed_size + CAMERA_PADDING,
                    ],
                };

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

                let camera_motion_blur = 0.0;

                let crop_bounds = match project.camera.shape {
                    CameraShape::Source => [0.0, 0.0, frame_size[0], frame_size[1]],
                    CameraShape::Square => [
                        (frame_size[0] - frame_size[1]) / 2.0,
                        0.0,
                        frame_size[0] - (frame_size[0] - frame_size[1]) / 2.0,
                        frame_size[1],
                    ],
                };

                CompositeVideoFrameUniforms {
                    output_size,
                    frame_size,
                    crop_bounds,
                    target_bounds,
                    target_size: [
                        target_bounds[2] - target_bounds[0],
                        target_bounds[3] - target_bounds[1],
                    ],
                    rounding_px: project.camera.rounding / 100.0 * 0.5 * size[0].min(size[1]),
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
                    opacity: scene.regular_camera_transition_opacity() as f32,
                    border_enabled: 0.0,
                    border_width: 0.0,
                    _padding0: 0.0,
                    _padding1: [0.0; 2],
                    _padding1b: [0.0; 2],
                    border_color: [0.0, 0.0, 0.0, 0.0],
                    _padding2: [0.0; 4],
                }
            });

        let camera_only = options
            .camera_size
            .filter(|_| !project.camera.hide && scene.is_transitioning_camera_only())
            .map(|camera_size| {
                let output_size = [output_size.0 as f32, output_size.1 as f32];
                let frame_size = [camera_size.x as f32, camera_size.y as f32];

                let aspect = frame_size[0] / frame_size[1];
                let output_aspect = output_size[0] / output_size[1];

                let zoom_factor = scene.camera_only_zoom as f32;
                let size = [output_size[0] * zoom_factor, output_size[1] * zoom_factor];

                let position = [
                    (output_size[0] - size[0]) / 2.0,
                    (output_size[1] - size[1]) / 2.0,
                ];

                let target_bounds = [
                    position[0],
                    position[1],
                    position[0] + size[0],
                    position[1] + size[1],
                ];

                // In camera-only mode, we ignore the camera shape setting (Square/Source)
                // and just apply the minimum crop needed to fill the output aspect ratio.
                // This prevents excessive zooming when shape is set to Square.
                let crop_bounds = if aspect > output_aspect {
                    // Camera is wider than output - crop left and right
                    let visible_width = frame_size[1] * output_aspect;
                    let crop_x = (frame_size[0] - visible_width) / 2.0;
                    [crop_x, 0.0, frame_size[0] - crop_x, frame_size[1]]
                } else {
                    // Camera is taller than output - crop top and bottom
                    let visible_height = frame_size[0] / output_aspect;
                    let crop_y = (frame_size[1] - visible_height) / 2.0;
                    [0.0, crop_y, frame_size[0], frame_size[1] - crop_y]
                };

                CompositeVideoFrameUniforms {
                    output_size,
                    frame_size,
                    crop_bounds,
                    target_bounds,
                    target_size: [
                        target_bounds[2] - target_bounds[0],
                        target_bounds[3] - target_bounds[1],
                    ],
                    rounding_px: 0.0,
                    mirror_x: if project.camera.mirror { 1.0 } else { 0.0 },
                    velocity_uv: [0.0, 0.0],
                    motion_blur_amount: 0.0,
                    camera_motion_blur_amount: scene.camera_only_blur as f32 * 0.5,
                    shadow: 0.0,
                    shadow_size: 0.0,
                    shadow_opacity: 0.0,
                    shadow_blur: 0.0,
                    opacity: scene.camera_only_transition_opacity() as f32,
                    border_enabled: 0.0,
                    border_width: 0.0,
                    _padding0: 0.0,
                    _padding1: [0.0; 2],
                    _padding1b: [0.0; 2],
                    border_color: [0.0, 0.0, 0.0, 0.0],
                    _padding2: [0.0; 4],
                }
            });

        Self {
            output_size,
            cursor_size: project.cursor.size as f32,
            resolution_base,
            display,
            camera,
            camera_only,
            project: project.clone(),
            zoom,
            scene,
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
            self.constants,
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
    camera_only: CameraLayer,
    #[allow(unused)]
    captions: CaptionsLayer,
}

impl RendererLayers {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        Self {
            background: BackgroundLayer::new(device),
            background_blur: BlurLayer::new(device),
            display: DisplayLayer::new(device),
            cursor: CursorLayer::new(device),
            camera: CameraLayer::new(device),
            camera_only: CameraLayer::new(device),
            captions: CaptionsLayer::new(device, queue),
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
                constants,
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
            uniforms.display,
        );

        self.cursor.prepare(
            segment_frames,
            uniforms.resolution_base,
            cursor,
            &uniforms.zoom,
            uniforms,
            constants,
        );

        self.camera.prepare(
            &constants.device,
            &constants.queue,
            (|| {
                Some((
                    uniforms.camera?,
                    constants.options.camera_size?,
                    segment_frames.camera_frame.as_ref()?,
                ))
            })(),
        );

        self.camera_only.prepare(
            &constants.device,
            &constants.queue,
            (|| {
                Some((
                    uniforms.camera_only?,
                    constants.options.camera_size?,
                    segment_frames.camera_frame.as_ref()?,
                ))
            })(),
        );

        Ok(())
    }

    pub fn render(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        session: &mut RenderSession,
        uniforms: &ProjectUniforms,
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
                wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
            );
            self.background.render(&mut pass);
        }

        if self.background_blur.blur_amount > 0.0 {
            let mut pass = render_pass!(session.other_texture_view(), wgpu::LoadOp::Load);
            self.background_blur
                .render(&mut pass, device, session.current_texture_view());

            session.swap_textures();
        }

        if uniforms.scene.should_render_screen() {
            let mut pass = render_pass!(session.current_texture_view(), wgpu::LoadOp::Load);
            self.display.render(&mut pass);
        }

        if uniforms.scene.should_render_screen() {
            let mut pass = render_pass!(session.current_texture_view(), wgpu::LoadOp::Load);
            self.cursor.render(&mut pass);
        }

        // Render camera-only layer when transitioning with CameraOnly mode
        if uniforms.scene.is_transitioning_camera_only() {
            let mut pass = render_pass!(session.current_texture_view(), wgpu::LoadOp::Load);
            self.camera_only.render(&mut pass);
        }

        // Also render regular camera overlay during transitions when its opacity > 0
        if uniforms.scene.should_render_camera()
            && uniforms.scene.regular_camera_transition_opacity() > 0.01
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
    readback_buffers: (Option<wgpu::Buffer>, Option<wgpu::Buffer>),
    readback_buffer_size: u64,
    current_readback_is_left: bool,
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
            readback_buffers: (None, None),
            readback_buffer_size: 0,
            current_readback_is_left: true,
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

    pub(crate) fn ensure_readback_buffers(&mut self, device: &wgpu::Device, size: u64) {
        let needs_new = self
            .readback_buffers
            .0
            .as_ref()
            .is_none_or(|_| self.readback_buffer_size < size);

        if needs_new {
            let make_buffer = || {
                device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("RenderSession Readback Buffer"),
                    size,
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                })
            };

            self.readback_buffers = (Some(make_buffer()), Some(make_buffer()));
            self.readback_buffer_size = size;
        }
    }

    pub(crate) fn current_readback_buffer(&self) -> &wgpu::Buffer {
        if self.current_readback_is_left {
            self.readback_buffers
                .0
                .as_ref()
                .expect("readback buffer should be initialised")
        } else {
            self.readback_buffers
                .1
                .as_ref()
                .expect("readback buffer should be initialised")
        }
    }

    pub(crate) fn swap_readback_buffers(&mut self) {
        self.current_readback_is_left = !self.current_readback_is_left;
    }
}

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

    layers.render(&constants.device, &mut encoder, session, &uniforms);

    finish_encoder(
        session,
        &constants.device,
        &constants.queue,
        &uniforms,
        encoder,
    )
    .await
}

fn parse_color_component(hex_color: &str, index: usize) -> f32 {
    let color = hex_color.trim_start_matches('#');

    if color.len() == 6 {
        let start = index * 2;
        if let Ok(value) = u8::from_str_radix(&color[start..start + 2], 16) {
            return value as f32 / 255.0;
        }
    }

    match index {
        0 => 1.0,
        1 => 1.0,
        2 => 1.0,
        _ => 1.0,
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

    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Render Pipeline"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            buffers: &[],
            compilation_options: wgpu::PipelineCompilationOptions {
                constants: &[],
                zero_initialize_workgroup_memory: false,
            },
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: wgpu::PipelineCompilationOptions {
                constants: &[],
                zero_initialize_workgroup_memory: false,
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

#[cfg(test)]
mod project_uniforms_tests {
    use super::*;
    use cap_project::CursorMoveEvent;

    fn cursor_move(time_ms: f64, x: f64, y: f64) -> CursorMoveEvent {
        CursorMoveEvent {
            active_modifiers: vec![],
            cursor_id: "primary".to_string(),
            time_ms,
            x,
            y,
        }
    }

    fn default_smoothing() -> SpringMassDamperSimulationConfig {
        SpringMassDamperSimulationConfig {
            tension: 100.0,
            mass: 1.0,
            friction: 20.0,
        }
    }

    #[test]
    fn auto_zoom_focus_defaults_without_cursor_data() {
        let events = CursorEvents {
            clicks: vec![],
            moves: vec![],
        };

        let focus = ProjectUniforms::auto_zoom_focus(&events, 0.3, None, None);

        assert_eq!(focus.coord.x, 0.5);
        assert_eq!(focus.coord.y, 0.5);
    }

    #[test]
    fn auto_zoom_focus_is_stable_for_slow_motion() {
        let events = CursorEvents {
            clicks: vec![],
            moves: vec![
                cursor_move(0.0, 0.5, 0.5),
                cursor_move(200.0, 0.55, 0.5),
                cursor_move(400.0, 0.6, 0.5),
            ],
        };

        let smoothing = Some(default_smoothing());

        let current = interpolate_cursor(&events, 0.4, smoothing).expect("cursor position");
        let focus =
            ProjectUniforms::auto_zoom_focus(&events, 0.4, smoothing, Some(current.clone()));

        let dx = (focus.coord.x - current.position.coord.x).abs();
        let dy = (focus.coord.y - current.position.coord.y).abs();

        assert!(dx < 0.05, "expected minimal horizontal drift, got {dx}");
        assert!(dy < 0.05, "expected minimal vertical drift, got {dy}");
    }

    #[test]
    fn auto_zoom_focus_leans_into_velocity_for_fast_motion() {
        let events = CursorEvents {
            clicks: vec![],
            moves: vec![cursor_move(0.0, 0.1, 0.5), cursor_move(40.0, 0.9, 0.5)],
        };

        let smoothing = Some(default_smoothing());
        let query_time = 0.045; // slightly after the fast movement

        let current = interpolate_cursor(&events, query_time, smoothing).expect("cursor position");
        let focus =
            ProjectUniforms::auto_zoom_focus(&events, query_time, smoothing, Some(current.clone()));
        let delta = focus.coord.x - current.position.coord.x;
        assert!(delta < 0.2, "focus moved too far ahead: {delta}");
        assert!(delta > -0.25, "focus lagged too far behind: {delta}");
    }
}
