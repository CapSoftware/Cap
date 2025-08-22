use anyhow::Result;
use cap_project::{
    CursorEvents, ProjectConfiguration, RecordingMeta, StudioRecordingMeta, XY,
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
mod layout;
mod layout_coordinates;
mod project_recordings;
mod spring_mass_damper;
mod zoom;

pub use coord::*;
pub use decoder::DecodedFrame;
pub use frame_pipeline::RenderedFrame;
pub use project_recordings::{ProjectRecordingsMeta, SegmentRecordings};
pub use layout_coordinates::*;

use layout::*;
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
    segments: Vec<RenderSegment>,
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

        let Some((segment_time, segment_i)) =
            project.get_segment_time(frame_number as f64 / fps as f64)
        else {
            break;
        };

        let segment = &segments[segment_i as usize];

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
                constants,
                project,
                frame_number,
                fps,
                resolution_base,
                &segment.cursor,
                &segment_frames,
            );

            let frame = frame_renderer
                .render(segment_frames, uniforms, &segment.cursor, &mut layers)
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
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .map_err(|_| RenderingError::NoAdapter)?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                required_features: wgpu::Features::MAPPABLE_PRIMARY_BUFFERS,
                ..Default::default()
            })
            .await?;

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
    pub layout: InterpolatedLayout,
    pub resolution_base: XY<u32>,
    pub layout_coordinates: LayoutCoordinates,
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
        let output_size = get_output_size(options, project, resolution_base);
        let frame_time = frame_number as f32 / fps as f32;

        let velocity = [0.0, 0.0];
        let motion_blur_amount = 0.0;

        let interpolated_cursor = interpolate_cursor(
            cursor_events,
            segment_frames.recording_time,
            (!project.cursor.raw).then_some(SpringMassDamperSimulationConfig {
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
                (!project.cursor.raw).then_some(SpringMassDamperSimulationConfig {
                    tension: project.cursor.tension,
                    mass: project.cursor.mass,
                    friction: project.cursor.friction,
                }),
            )
            .as_ref()
            .map(|i| i.position)
            .unwrap_or_else(|| Coord::new(XY::new(0.5, 0.5))),
        );

        let layout = InterpolatedLayout::new(LayoutSegmentsCursor::new(
            frame_time as f64,
            project
                .timeline
                .as_ref()
                .map(|t| t.layout_segments.as_slice())
                .unwrap_or(&[]),
        ));

        // Calculate all layout coordinates first
        let layout_coordinates = LayoutCoordinates::calculate(
            options,
            project,
            resolution_base,
            &zoom,
            &layout,
            interpolated_cursor.as_ref(),
            project.cursor.size as f32,
        );

        // Generate shader uniforms from coordinates
        let display = Self::create_display_uniforms(
            options,
            project,
            &layout_coordinates.display,
            &layout,
            motion_blur_amount,
            velocity,
        );

        let camera = layout_coordinates.camera.as_ref().map(|camera_coords| {
            Self::create_camera_uniforms(
                options,
                project,
                camera_coords,
                &layout,
                motion_blur_amount,
            )
        });

        let camera_only = layout_coordinates.camera_only.as_ref().map(|camera_only_coords| {
            Self::create_camera_only_uniforms(
                options,
                project,
                camera_only_coords,
                &layout,
            )
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
            layout,
            interpolated_cursor,
            layout_coordinates,
        }
    }

    fn create_display_uniforms(
        options: &RenderOptions,
        project: &ProjectConfiguration,
        display_coords: &DisplayCoordinates,
        layout: &InterpolatedLayout,
        motion_blur_amount: f32,
        velocity: [f32; 2],
    ) -> CompositeVideoFrameUniforms {
        let size = [options.screen_size.x as f32, options.screen_size.y as f32];
        let min_target_axis = display_coords.target_size.x.min(display_coords.target_size.y);
        let output_size = [display_coords.target_end.x as f32, display_coords.target_end.y as f32];

        CompositeVideoFrameUniforms {
            output_size,
            frame_size: size,
            crop_bounds: [
                display_coords.crop_start.x as f32,
                display_coords.crop_start.y as f32,
                display_coords.crop_end.x as f32,
                display_coords.crop_end.y as f32,
            ],
            target_bounds: [
                display_coords.target_start.x as f32,
                display_coords.target_start.y as f32,
                display_coords.target_end.x as f32,
                display_coords.target_end.y as f32,
            ],
            target_size: [
                display_coords.target_size.x as f32,
                display_coords.target_size.y as f32,
            ],
            rounding_px: (project.background.rounding / 100.0 * 0.5 * min_target_axis) as f32,
            mirror_x: 0.0,
            velocity_uv: velocity,
            motion_blur_amount: (motion_blur_amount + layout.screen_blur as f32 * 0.8).min(1.0),
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
            opacity: layout.screen_opacity as f32,
            _padding: [0.0; 3],
        }
    }

    fn create_camera_uniforms(
        options: &RenderOptions,
        project: &ProjectConfiguration,
        camera_coords: &CameraCoordinates,
        layout: &InterpolatedLayout,
        motion_blur_amount: f32,
    ) -> CompositeVideoFrameUniforms {
        let camera_size = options.camera_size.unwrap();
        let frame_size = [camera_size.x as f32, camera_size.y as f32];
        let output_size = [camera_coords.target_end.x as f32, camera_coords.target_end.y as f32];

        CompositeVideoFrameUniforms {
            output_size,
            frame_size,
            crop_bounds: [
                camera_coords.crop_start.x as f32,
                camera_coords.crop_start.y as f32,
                camera_coords.crop_end.x as f32,
                camera_coords.crop_end.y as f32,
            ],
            target_bounds: [
                camera_coords.target_start.x as f32,
                camera_coords.target_start.y as f32,
                camera_coords.target_end.x as f32,
                camera_coords.target_end.y as f32,
            ],
            target_size: [camera_coords.size.x as f32, camera_coords.size.y as f32],
            rounding_px: project.camera.rounding / 100.0 * 0.5 * camera_coords.size.x.min(camera_coords.size.y) as f32,
            mirror_x: if project.camera.mirror { 1.0 } else { 0.0 },
            velocity_uv: [0.0, 0.0],
            motion_blur_amount,
            camera_motion_blur_amount: 0.0,
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
            opacity: layout.regular_camera_transition_opacity() as f32,
            _padding: [0.0; 3],
        }
    }

    fn create_camera_only_uniforms(
        options: &RenderOptions,
        project: &ProjectConfiguration,
        camera_only_coords: &CameraOnlyCoordinates,
        layout: &InterpolatedLayout,
    ) -> CompositeVideoFrameUniforms {
        let camera_size = options.camera_size.unwrap();
        let frame_size = [camera_size.x as f32, camera_size.y as f32];
        let output_size = [camera_only_coords.target_end.x as f32, camera_only_coords.target_end.y as f32];

        CompositeVideoFrameUniforms {
            output_size,
            frame_size,
            crop_bounds: [
                camera_only_coords.crop_start.x as f32,
                camera_only_coords.crop_start.y as f32,
                camera_only_coords.crop_end.x as f32,
                camera_only_coords.crop_end.y as f32,
            ],
            target_bounds: [
                camera_only_coords.target_start.x as f32,
                camera_only_coords.target_start.y as f32,
                camera_only_coords.target_end.x as f32,
                camera_only_coords.target_end.y as f32,
            ],
            target_size: [camera_only_coords.size.x as f32, camera_only_coords.size.y as f32],
            rounding_px: 0.0,
            mirror_x: if project.camera.mirror { 1.0 } else { 0.0 },
            velocity_uv: [0.0, 0.0],
            motion_blur_amount: 0.0,
            camera_motion_blur_amount: layout.camera_only_blur as f32 * 0.5,
            shadow: 0.0,
            shadow_size: 0.0,
            shadow_opacity: 0.0,
            shadow_blur: 0.0,
            opacity: layout.camera_only_transition_opacity() as f32,
            _padding: [0.0; 3],
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

        if uniforms.layout.should_render_screen() {
            let mut pass = render_pass!(session.current_texture_view(), wgpu::LoadOp::Load);
            self.display.render(&mut pass);
        }

        if uniforms.layout.should_render_screen() {
            let mut pass = render_pass!(session.current_texture_view(), wgpu::LoadOp::Load);
            self.cursor.render(&mut pass);
        }

        // Render camera-only layer when transitioning with CameraOnly mode
        if uniforms.layout.is_transitioning_camera_only() {
            let mut pass = render_pass!(session.current_texture_view(), wgpu::LoadOp::Load);
            self.camera_only.render(&mut pass);
        }

        // Also render regular camera overlay during transitions when its opacity > 0
        if uniforms.layout.should_render_camera()
            && uniforms.layout.regular_camera_transition_opacity() > 0.01
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
