use anyhow::Result;
use cap_project::{
    AspectRatio, CameraShape, CameraXPosition, CameraYPosition, ClipOffsets, CornerStyle, Crop,
    CursorEvents, MaskKind, ProjectConfiguration, RecordingMeta, StudioRecordingMeta, XY,
};
use composite_frame::CompositeVideoFrameUniforms;
use core::f64;
use cursor_interpolation::{InterpolatedCursorPosition, interpolate_cursor};
use decoder::{AsyncVideoDecoderHandle, spawn_decoder};
use frame_pipeline::{RenderSession, finish_encoder, finish_encoder_nv12, flush_pending_readback};
use futures::FutureExt;
use futures::future::OptionFuture;
use layers::{
    Background, BackgroundLayer, BlurLayer, CameraLayer, CaptionsLayer, CursorLayer, DisplayLayer,
    MaskLayer, TextLayer,
};
use specta::Type;
use spring_mass_damper::SpringMassDamperSimulationConfig;
use std::{collections::HashMap, sync::Arc};
use std::{path::PathBuf, time::Instant};
use tokio::sync::mpsc;

pub mod composite_frame;
mod coord;
pub mod cpu_yuv;
mod cursor_interpolation;
#[cfg(target_os = "windows")]
pub mod d3d_texture;
pub mod decoder;
mod frame_pipeline;
#[cfg(target_os = "macos")]
pub mod iosurface_texture;
mod layers;
mod mask;
mod project_recordings;
mod scene;
pub mod spring_mass_damper;
mod text;
pub mod yuv_converter;
mod zoom;
pub mod zoom_focus_interpolation;

pub use coord::*;
pub use decoder::{DecodedFrame, DecoderStatus, DecoderType, PixelFormat};
pub use frame_pipeline::{GpuOutputFormat, Nv12RenderedFrame, RenderedFrame};
pub use project_recordings::{ProjectRecordingsMeta, SegmentRecordings, Video};

use mask::interpolate_masks;
use scene::*;
use text::{PreparedText, prepare_texts};
use zoom::*;
pub use zoom_focus_interpolation::ZoomFocusInterpolator;

const STANDARD_CURSOR_HEIGHT: f32 = 75.0;

fn rounding_type_value(style: CornerStyle) -> f32 {
    match style {
        CornerStyle::Rounded => 0.0,
        CornerStyle::Squircle => 1.0,
    }
}

#[derive(Debug, Clone, Copy, Type)]
pub struct RenderOptions {
    pub camera_size: Option<XY<u32>>,
    pub screen_size: XY<u32>,
}

#[derive(Debug, Clone, Copy)]
pub enum MaskRenderMode {
    Sensitive,
    Highlight,
}

impl MaskRenderMode {
    fn from_kind(kind: MaskKind) -> Self {
        match kind {
            MaskKind::Sensitive => MaskRenderMode::Sensitive,
            MaskKind::Highlight => MaskRenderMode::Highlight,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PreparedMask {
    pub center: XY<f32>,
    pub size: XY<f32>,
    pub feather: f32,
    pub opacity: f32,
    pub pixel_size: f32,
    pub darkness: f32,
    pub mode: MaskRenderMode,
    pub output_size: XY<u32>,
}

impl PreparedMask {
    fn mode_value(&self) -> u32 {
        match self.mode {
            MaskRenderMode::Sensitive => 0,
            MaskRenderMode::Highlight => 1,
        }
    }
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
        force_ffmpeg: bool,
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
            force_ffmpeg,
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
                        inner.segments[segment_i].camera.as_ref().unwrap().fps
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
                force_ffmpeg,
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
        let camera_request_time = segment_time + offsets.camera;
        let (screen, camera) = tokio::join!(
            self.screen.get_frame(segment_time),
            OptionFuture::from(
                needs_camera
                    .then(|| self
                        .camera
                        .as_ref()
                        .map(|d| d.get_frame(camera_request_time)))
                    .flatten()
            )
        );

        let camera_frame = camera.flatten();

        Some(DecodedSegmentFrames {
            screen_frame: screen?,
            camera_frame,
            segment_time,
            recording_time: segment_time + self.segment_offset as f32,
        })
    }

    pub async fn get_frames_initial(
        &self,
        segment_time: f32,
        needs_camera: bool,
        offsets: ClipOffsets,
    ) -> Option<DecodedSegmentFrames> {
        let camera_request_time = segment_time + offsets.camera;
        let (screen, camera) = tokio::join!(
            self.screen.get_frame_initial(segment_time),
            OptionFuture::from(
                needs_camera
                    .then(|| self
                        .camera
                        .as_ref()
                        .map(|d| d.get_frame_initial(camera_request_time)))
                    .flatten()
            )
        );

        let camera_frame = camera.flatten();

        Some(DecodedSegmentFrames {
            screen_frame: screen?,
            camera_frame,
            segment_time,
            recording_time: segment_time + self.segment_offset as f32,
        })
    }

    pub fn screen_video_dimensions(&self) -> (u32, u32) {
        self.screen.video_dimensions()
    }

    pub fn camera_video_dimensions(&self) -> Option<(u32, u32)> {
        self.camera.as_ref().map(|c| c.video_dimensions())
    }
}

#[derive(thiserror::Error, Debug)]
pub enum RenderingError {
    #[error("No GPU adapter found")]
    NoAdapter,
    #[error("No segments available in recording")]
    NoSegments,
    #[error(transparent)]
    RequestDeviceFailed(#[from] wgpu::RequestDeviceError),
    #[error("Failed to wait for buffer mapping")]
    BufferMapWaitingFailed,
    #[error(transparent)]
    BufferMapFailed(#[from] wgpu::BufferAsyncError),
    #[error("Sending frame to channel failed")]
    ChannelSendFrameFailed(#[from] mpsc::error::SendError<(RenderedFrame, u32)>),
    #[error("Sending NV12 frame to channel failed")]
    ChannelSendNv12FrameFailed(#[from] mpsc::error::SendError<(Nv12RenderedFrame, u32)>),
    #[error("Failed to load image: {0}")]
    ImageLoadError(String),
    #[error("Error polling wgpu: {0}")]
    PollError(#[from] wgpu::PollError),
    #[error(
        "Failed to decode video frames. The recording may be corrupted or incomplete. Try re-recording or contact support if the issue persists."
    )]
    FrameDecodeFailed {
        frame_number: u32,
        consecutive_failures: u32,
    },
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

    let cursor_smoothing =
        (!project.cursor.raw).then_some(spring_mass_damper::SpringMassDamperSimulationConfig {
            tension: project.cursor.tension,
            mass: project.cursor.mass,
            friction: project.cursor.friction,
        });

    let zoom_focus_interpolators: Vec<ZoomFocusInterpolator> = render_segments
        .iter()
        .map(|segment| {
            let mut interp = ZoomFocusInterpolator::new(
                &segment.cursor,
                cursor_smoothing,
                project.screen_movement_spring,
                duration,
            );
            interp.precompute();
            interp
        })
        .collect();

    let mut frame_number = 0;

    let mut frame_renderer = FrameRenderer::new(constants);

    let mut layers = RendererLayers::new_with_options(
        &constants.device,
        &constants.queue,
        constants.is_software_adapter,
    );

    if let Some(first_segment) = render_segments.first() {
        let (screen_w, screen_h) = first_segment.decoders.screen_video_dimensions();
        let camera_dims = first_segment.decoders.camera_video_dimensions();
        layers.prepare_for_video_dimensions(
            &constants.device,
            screen_w,
            screen_h,
            camera_dims.map(|(w, _)| w),
            camera_dims.map(|(_, h)| h),
        );
    }

    let needs_camera = !project.camera.hide;
    let mut last_successful_frame: Option<RenderedFrame> = None;
    let mut consecutive_failures = 0u32;
    const MAX_CONSECUTIVE_FAILURES: u32 = 200;

    let mut prefetched_decode: Option<(u32, f64, usize, Option<DecodedSegmentFrames>)> = None;

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

        let current_frame_number = {
            let prev = frame_number;
            std::mem::replace(&mut frame_number, prev + 1)
        };

        let render_segment = &render_segments[segment.recording_clip as usize];
        let is_initial_frame = current_frame_number == 0 || last_successful_frame.is_none();
        let segment_clip_index = segment.recording_clip as usize;

        let segment_frames =
            if let Some((pf_num, _pf_time, pf_clip, pf_result)) = prefetched_decode.take() {
                if pf_num == current_frame_number && pf_clip == segment_clip_index {
                    pf_result
                } else {
                    decode_segment_frames_with_retry(
                        &render_segment.decoders,
                        segment_time,
                        needs_camera,
                        clip_config.map(|v| v.offsets).unwrap_or_default(),
                        current_frame_number,
                        is_initial_frame,
                    )
                    .await
                }
            } else {
                decode_segment_frames_with_retry(
                    &render_segment.decoders,
                    segment_time,
                    needs_camera,
                    clip_config.map(|v| v.offsets).unwrap_or_default(),
                    current_frame_number,
                    is_initial_frame,
                )
                .await
            };

        if let Some(segment_frames) = segment_frames {
            consecutive_failures = 0;

            let zoom_focus_interp = &zoom_focus_interpolators[segment_clip_index];

            let uniforms = ProjectUniforms::new(
                constants,
                project,
                current_frame_number,
                fps,
                resolution_base,
                &render_segment.cursor,
                &segment_frames,
                duration,
                zoom_focus_interp,
            );

            let next_frame_number = frame_number;
            let mut next_prefetch_meta: Option<(f64, usize)> = None;
            let prefetch_future = if next_frame_number < total_frames {
                if let Some((next_seg_time, next_segment)) =
                    project.get_segment_time(next_frame_number as f64 / fps as f64)
                {
                    let next_clip_index = next_segment.recording_clip as usize;
                    next_prefetch_meta = Some((next_seg_time, next_clip_index));
                    let next_render_segment = &render_segments[next_clip_index];
                    let next_clip_config = project
                        .clips
                        .iter()
                        .find(|v| v.index == next_segment.recording_clip);
                    let next_is_initial = last_successful_frame.is_none();

                    Some(decode_segment_frames_with_retry(
                        &next_render_segment.decoders,
                        next_seg_time,
                        needs_camera,
                        next_clip_config.map(|v| v.offsets).unwrap_or_default(),
                        next_frame_number,
                        next_is_initial,
                    ))
                } else {
                    None
                }
            } else {
                None
            };

            let render_result = if let Some(prefetch) = prefetch_future {
                let (render, decoded) = tokio::join!(
                    frame_renderer.render(
                        segment_frames,
                        uniforms,
                        &render_segment.cursor,
                        &mut layers,
                    ),
                    prefetch
                );

                if let Some((next_seg_time, next_clip_index)) = next_prefetch_meta {
                    prefetched_decode =
                        Some((next_frame_number, next_seg_time, next_clip_index, decoded));
                }

                render
            } else {
                frame_renderer
                    .render(
                        segment_frames,
                        uniforms,
                        &render_segment.cursor,
                        &mut layers,
                    )
                    .await
            };

            match render_result {
                Ok(Some(frame)) if frame.width > 0 && frame.height > 0 => {
                    last_successful_frame = Some(frame.clone());
                    sender.send((frame, current_frame_number)).await?;
                }
                Ok(Some(_)) => {
                    tracing::warn!(
                        frame_number = current_frame_number,
                        "Rendered frame has zero dimensions"
                    );
                    if let Some(ref last_frame) = last_successful_frame {
                        let mut fallback = last_frame.clone();
                        fallback.frame_number = current_frame_number;
                        fallback.target_time_ns =
                            (current_frame_number as u64 * 1_000_000_000) / fps as u64;
                        sender.send((fallback, current_frame_number)).await?;
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::error!(
                        frame_number = current_frame_number,
                        error = %e,
                        "Frame rendering failed"
                    );
                    if let Some(ref last_frame) = last_successful_frame {
                        let mut fallback = last_frame.clone();
                        fallback.frame_number = current_frame_number;
                        fallback.target_time_ns =
                            (current_frame_number as u64 * 1_000_000_000) / fps as u64;
                        sender.send((fallback, current_frame_number)).await?;
                    } else {
                        return Err(e);
                    }
                }
            }
        } else {
            consecutive_failures += 1;

            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                tracing::error!(
                    frame_number = current_frame_number,
                    consecutive_failures = consecutive_failures,
                    "Too many consecutive frame failures - aborting export"
                );
                return Err(RenderingError::FrameDecodeFailed {
                    frame_number: current_frame_number,
                    consecutive_failures,
                });
            }

            if let Some(ref last_frame) = last_successful_frame {
                tracing::warn!(
                    frame_number = current_frame_number,
                    segment_time = segment_time,
                    consecutive_failures = consecutive_failures,
                    max_retries = DECODE_MAX_RETRIES,
                    "Frame decode failed after retries - using previous frame"
                );
                let mut fallback = last_frame.clone();
                fallback.frame_number = current_frame_number;
                fallback.target_time_ns =
                    (current_frame_number as u64 * 1_000_000_000) / fps as u64;
                sender.send((fallback, current_frame_number)).await?;
            } else {
                tracing::error!(
                    frame_number = current_frame_number,
                    segment_time = segment_time,
                    max_retries = DECODE_MAX_RETRIES,
                    "First frame decode failed after retries - cannot continue"
                );
                continue;
            }
        }
    }

    if let Some(Ok(final_frame)) = frame_renderer.flush_pipeline().await
        && final_frame.width > 0
        && final_frame.height > 0
    {
        sender
            .send((final_frame, frame_number.saturating_sub(1)))
            .await?;
    }

    let total_time = start_time.elapsed();
    tracing::info!(
        frames = frame_number,
        elapsed_secs = format!("{:.2}", total_time.as_secs_f32()),
        "Render complete"
    );

    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn render_video_to_channel_nv12(
    constants: &RenderVideoConstants,
    project: &ProjectConfiguration,
    sender: mpsc::Sender<(Nv12RenderedFrame, u32)>,
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

    let cursor_smoothing =
        (!project.cursor.raw).then_some(spring_mass_damper::SpringMassDamperSimulationConfig {
            tension: project.cursor.tension,
            mass: project.cursor.mass,
            friction: project.cursor.friction,
        });

    let zoom_focus_interpolators: Vec<ZoomFocusInterpolator> = render_segments
        .iter()
        .map(|segment| {
            let mut interp = ZoomFocusInterpolator::new(
                &segment.cursor,
                cursor_smoothing,
                project.screen_movement_spring,
                duration,
            );
            interp.precompute();
            interp
        })
        .collect();

    let mut frame_number = 0;

    let mut frame_renderer = FrameRenderer::new(constants);

    let mut layers = RendererLayers::new_with_options(
        &constants.device,
        &constants.queue,
        constants.is_software_adapter,
    );

    if let Some(first_segment) = render_segments.first() {
        let (screen_w, screen_h) = first_segment.decoders.screen_video_dimensions();
        let camera_dims = first_segment.decoders.camera_video_dimensions();
        layers.prepare_for_video_dimensions(
            &constants.device,
            screen_w,
            screen_h,
            camera_dims.map(|(w, _)| w),
            camera_dims.map(|(_, h)| h),
        );
    }

    let needs_camera = !project.camera.hide;

    let mut last_successful_frame: Option<Nv12RenderedFrame> = None;
    let mut consecutive_failures = 0u32;
    const MAX_CONSECUTIVE_FAILURES: u32 = 200;

    let mut prefetched_decode: Option<(u32, f64, usize, Option<DecodedSegmentFrames>)> = None;

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

        let current_frame_number = {
            let prev = frame_number;
            std::mem::replace(&mut frame_number, prev + 1)
        };

        let render_segment = &render_segments[segment.recording_clip as usize];
        let is_initial_frame = current_frame_number == 0 || last_successful_frame.is_none();
        let segment_clip_index = segment.recording_clip as usize;

        let segment_frames =
            if let Some((pf_num, _pf_time, pf_clip, pf_result)) = prefetched_decode.take() {
                if pf_num == current_frame_number && pf_clip == segment_clip_index {
                    pf_result
                } else {
                    decode_segment_frames_with_retry(
                        &render_segment.decoders,
                        segment_time,
                        needs_camera,
                        clip_config.map(|v| v.offsets).unwrap_or_default(),
                        current_frame_number,
                        is_initial_frame,
                    )
                    .await
                }
            } else {
                decode_segment_frames_with_retry(
                    &render_segment.decoders,
                    segment_time,
                    needs_camera,
                    clip_config.map(|v| v.offsets).unwrap_or_default(),
                    current_frame_number,
                    is_initial_frame,
                )
                .await
            };

        if let Some(segment_frames) = segment_frames {
            consecutive_failures = 0;

            let zoom_focus_interp = &zoom_focus_interpolators[segment_clip_index];

            let uniforms = ProjectUniforms::new(
                constants,
                project,
                current_frame_number,
                fps,
                resolution_base,
                &render_segment.cursor,
                &segment_frames,
                duration,
                zoom_focus_interp,
            );

            let next_frame_number = frame_number;
            let mut next_prefetch_meta: Option<(f64, usize)> = None;
            let prefetch_future = if next_frame_number < total_frames {
                if let Some((next_seg_time, next_segment)) =
                    project.get_segment_time(next_frame_number as f64 / fps as f64)
                {
                    let next_clip_index = next_segment.recording_clip as usize;
                    next_prefetch_meta = Some((next_seg_time, next_clip_index));
                    let next_render_segment = &render_segments[next_clip_index];
                    let next_clip_config = project
                        .clips
                        .iter()
                        .find(|v| v.index == next_segment.recording_clip);
                    let next_is_initial = last_successful_frame.is_none();

                    Some(decode_segment_frames_with_retry(
                        &next_render_segment.decoders,
                        next_seg_time,
                        needs_camera,
                        next_clip_config.map(|v| v.offsets).unwrap_or_default(),
                        next_frame_number,
                        next_is_initial,
                    ))
                } else {
                    None
                }
            } else {
                None
            };

            let render_result = if let Some(prefetch) = prefetch_future {
                let (render, decoded) = tokio::join!(
                    frame_renderer.render_nv12(
                        segment_frames,
                        uniforms,
                        &render_segment.cursor,
                        &mut layers,
                    ),
                    prefetch
                );

                if let Some((next_seg_time, next_clip_index)) = next_prefetch_meta {
                    prefetched_decode =
                        Some((next_frame_number, next_seg_time, next_clip_index, decoded));
                }

                render
            } else {
                frame_renderer
                    .render_nv12(
                        segment_frames,
                        uniforms,
                        &render_segment.cursor,
                        &mut layers,
                    )
                    .await
            };

            match render_result {
                Ok(Some(frame)) if frame.width > 0 && frame.height > 0 => {
                    last_successful_frame = Some(frame.clone_metadata_with_data());
                    sender.send((frame, current_frame_number)).await?;
                }
                Ok(Some(_)) => {
                    tracing::warn!(
                        frame_number = current_frame_number,
                        "Rendered NV12 frame has zero dimensions"
                    );
                    if let Some(ref last_frame) = last_successful_frame {
                        let mut fallback = last_frame.clone_metadata_with_data();
                        fallback.frame_number = current_frame_number;
                        fallback.target_time_ns =
                            (current_frame_number as u64 * 1_000_000_000) / fps as u64;
                        sender.send((fallback, current_frame_number)).await?;
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::error!(
                        frame_number = current_frame_number,
                        error = %e,
                        "NV12 frame rendering failed"
                    );
                    if let Some(ref last_frame) = last_successful_frame {
                        let mut fallback = last_frame.clone_metadata_with_data();
                        fallback.frame_number = current_frame_number;
                        fallback.target_time_ns =
                            (current_frame_number as u64 * 1_000_000_000) / fps as u64;
                        sender.send((fallback, current_frame_number)).await?;
                    } else {
                        return Err(e);
                    }
                }
            }
        } else {
            consecutive_failures += 1;

            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                tracing::error!(
                    frame_number = current_frame_number,
                    consecutive_failures = consecutive_failures,
                    "Too many consecutive frame failures - aborting export"
                );
                return Err(RenderingError::FrameDecodeFailed {
                    frame_number: current_frame_number,
                    consecutive_failures,
                });
            }

            if let Some(ref last_frame) = last_successful_frame {
                tracing::warn!(
                    frame_number = current_frame_number,
                    segment_time = segment_time,
                    consecutive_failures = consecutive_failures,
                    max_retries = DECODE_MAX_RETRIES,
                    "Frame decode failed after retries - using previous NV12 frame"
                );
                let mut fallback = last_frame.clone_metadata_with_data();
                fallback.frame_number = current_frame_number;
                fallback.target_time_ns =
                    (current_frame_number as u64 * 1_000_000_000) / fps as u64;
                sender.send((fallback, current_frame_number)).await?;
            } else {
                tracing::error!(
                    frame_number = current_frame_number,
                    segment_time = segment_time,
                    max_retries = DECODE_MAX_RETRIES,
                    "First frame decode failed after retries - cannot continue"
                );
                continue;
            }
        }
    }

    if let Some(Ok(final_frame)) = frame_renderer.flush_pipeline_nv12().await
        && final_frame.width > 0
        && final_frame.height > 0
    {
        sender
            .send((final_frame, frame_number.saturating_sub(1)))
            .await?;
    }

    let total_time = start_time.elapsed();
    tracing::info!(
        frames = frame_number,
        elapsed_secs = format!("{:.2}", total_time.as_secs_f32()),
        "NV12 render complete"
    );

    Ok(())
}

const DECODE_MAX_RETRIES: u32 = 5;

async fn decode_segment_frames_with_retry(
    decoders: &RecordingSegmentDecoders,
    segment_time: f64,
    needs_camera: bool,
    offsets: cap_project::ClipOffsets,
    current_frame_number: u32,
    is_initial_frame: bool,
) -> Option<DecodedSegmentFrames> {
    let mut result = None;
    let mut retry_count = 0u32;

    while result.is_none() && retry_count < DECODE_MAX_RETRIES {
        if retry_count > 0 {
            let delay = if is_initial_frame {
                500 * (retry_count as u64 + 1)
            } else {
                50 * retry_count as u64
            };
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }

        result = if is_initial_frame {
            decoders
                .get_frames_initial(segment_time as f32, needs_camera, offsets)
                .await
        } else {
            decoders
                .get_frames(segment_time as f32, needs_camera, offsets)
                .await
        };

        if result.is_none() {
            retry_count += 1;
            if retry_count < DECODE_MAX_RETRIES {
                tracing::warn!(
                    frame_number = current_frame_number,
                    segment_time = segment_time,
                    retry_count = retry_count,
                    is_initial = is_initial_frame,
                    "Frame decode failed, retrying..."
                );
            }
        }
    }

    result
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
    pub is_software_adapter: bool,
}

pub struct SharedWgpuDevice {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub is_software_adapter: bool,
}

impl RenderVideoConstants {
    pub fn new_with_device(
        shared: SharedWgpuDevice,
        segments: &[SegmentRecordings],
        recording_meta: RecordingMeta,
        meta: StudioRecordingMeta,
    ) -> Result<Self, RenderingError> {
        let first_segment = segments.first().ok_or(RenderingError::NoSegments)?;

        let options = RenderOptions {
            screen_size: XY::new(first_segment.display.width, first_segment.display.height),
            camera_size: first_segment
                .camera
                .as_ref()
                .map(|c| XY::new(c.width, c.height)),
        };

        let background_textures = Arc::new(tokio::sync::RwLock::new(HashMap::new()));

        Ok(Self {
            _instance: shared.instance,
            _adapter: shared.adapter,
            device: shared.device,
            queue: shared.queue,
            options,
            background_textures,
            meta,
            recording_meta,
            is_software_adapter: shared.is_software_adapter,
        })
    }

    pub async fn new(
        segments: &[SegmentRecordings],
        recording_meta: RecordingMeta,
        meta: StudioRecordingMeta,
    ) -> Result<Self, RenderingError> {
        let first_segment = segments.first().ok_or(RenderingError::NoSegments)?;

        let options = RenderOptions {
            screen_size: XY::new(first_segment.display.width, first_segment.display.height),
            camera_size: first_segment
                .camera
                .as_ref()
                .map(|c| XY::new(c.width, c.height)),
        };

        #[cfg(not(target_os = "windows"))]
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());

        #[cfg(target_os = "windows")]
        let instance = {
            let dx12_instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
                backends: wgpu::Backends::DX12,
                ..Default::default()
            });
            let has_dx12 = dx12_instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    force_fallback_adapter: false,
                    compatible_surface: None,
                })
                .await
                .is_ok();
            if has_dx12 {
                tracing::info!("Using DX12 backend for optimal D3D11 interop");
                dx12_instance
            } else {
                tracing::info!("DX12 not available, falling back to all backends");
                wgpu::Instance::new(&wgpu::InstanceDescriptor::default())
            }
        };

        let hardware_adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: None,
            })
            .await
            .ok();

        let (adapter, is_software_adapter) = if let Some(adapter) = hardware_adapter {
            tracing::info!(
                adapter_name = adapter.get_info().name,
                adapter_backend = ?adapter.get_info().backend,
                "Using hardware GPU adapter"
            );
            (adapter, false)
        } else {
            tracing::warn!("No hardware GPU adapter found, attempting software fallback");
            let software_adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::LowPower,
                    force_fallback_adapter: true,
                    compatible_surface: None,
                })
                .await
                .map_err(|_| RenderingError::NoAdapter)?;

            tracing::info!(
                adapter_name = software_adapter.get_info().name,
                adapter_backend = ?software_adapter.get_info().backend,
                "Using software adapter (CPU rendering - performance may be reduced)"
            );
            (software_adapter, true)
        };

        let mut required_features = wgpu::Features::empty();
        if adapter.features().contains(wgpu::Features::PIPELINE_CACHE) {
            required_features |= wgpu::Features::PIPELINE_CACHE;
        }

        let device_descriptor = wgpu::DeviceDescriptor {
            label: Some("cap-rendering-device"),
            required_features,
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
            is_software_adapter,
        })
    }
}

#[derive(Clone, Debug)]
pub struct ProjectUniforms {
    pub output_size: (u32, u32),
    pub cursor_size: f32,
    pub frame_rate: u32,
    pub frame_number: u32,
    display: CompositeVideoFrameUniforms,
    camera: Option<CompositeVideoFrameUniforms>,
    camera_only: Option<CompositeVideoFrameUniforms>,
    interpolated_cursor: Option<InterpolatedCursorPosition>,
    pub prev_cursor: Option<InterpolatedCursorPosition>,
    pub project: ProjectConfiguration,
    pub zoom: InterpolatedZoom,
    pub scene: InterpolatedScene,
    pub resolution_base: XY<u32>,
    pub display_parent_motion_px: XY<f32>,
    pub motion_blur_amount: f32,
    pub masks: Vec<PreparedMask>,
    pub texts: Vec<PreparedText>,
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

#[derive(Clone, Copy, Debug)]
struct MotionBounds {
    start: Coord<FrameSpace>,
    end: Coord<FrameSpace>,
}

impl MotionBounds {
    fn new(start: Coord<FrameSpace>, end: Coord<FrameSpace>) -> Self {
        Self { start, end }
    }

    fn size(&self) -> XY<f64> {
        (self.end - self.start).coord
    }

    fn center(&self) -> XY<f64> {
        (self.start.coord + self.end.coord) * 0.5
    }

    fn diagonal(&self) -> f64 {
        let size = self.size();
        (size.x * size.x + size.y * size.y).sqrt().max(f64::EPSILON)
    }

    fn contains(&self, other: &Self) -> bool {
        self.start.coord.x <= other.start.coord.x
            && self.start.coord.y <= other.start.coord.y
            && self.end.coord.x >= other.end.coord.x
            && self.end.coord.y >= other.end.coord.y
    }

    fn point_to_uv(&self, point: XY<f64>) -> XY<f32> {
        let size = self.size();
        XY::new(
            ((point.x - self.start.coord.x) / size.x.max(f64::EPSILON)) as f32,
            ((point.y - self.start.coord.y) / size.y.max(f64::EPSILON)) as f32,
        )
    }

    fn top_left(&self) -> XY<f64> {
        self.start.coord
    }

    fn top_right(&self) -> XY<f64> {
        XY::new(self.end.coord.x, self.start.coord.y)
    }

    fn bottom_left(&self) -> XY<f64> {
        XY::new(self.start.coord.x, self.end.coord.y)
    }

    fn bottom_right(&self) -> XY<f64> {
        self.end.coord
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct MotionAnalysis {
    movement_px: XY<f32>,
    movement_uv: XY<f32>,
    movement_magnitude: f32,
    zoom_center_uv: XY<f32>,
    zoom_magnitude: f32,
}

#[derive(Clone, Copy, Debug)]
struct MotionBlurComputation {
    descriptor: MotionBlurDescriptor,
    parent_movement_px: XY<f32>,
}

impl MotionBlurComputation {
    fn none() -> Self {
        Self {
            descriptor: MotionBlurDescriptor::none(),
            parent_movement_px: XY::new(0.0, 0.0),
        }
    }
}

fn analyze_motion(current: &MotionBounds, previous: &MotionBounds) -> MotionAnalysis {
    let mut analysis = MotionAnalysis::default();

    let current_center = current.center();
    let prev_center = previous.center();
    let movement_px = XY::new(
        (current_center.x - prev_center.x) as f32,
        (current_center.y - prev_center.y) as f32,
    );

    let current_size = current.size();
    let previous_size = previous.size();
    let min_current = current_size.x.min(current_size.y);
    let min_previous = previous_size.x.min(previous_size.y);
    let base_span = min_current.max(min_previous).max(1.0) as f32;

    let movement_uv = XY::new(movement_px.x / base_span, movement_px.y / base_span);
    let movement_magnitude = (movement_uv.x * movement_uv.x + movement_uv.y * movement_uv.y).sqrt();

    let prev_diag = previous.diagonal();
    let curr_diag = current.diagonal();
    let zoom_magnitude = if prev_diag <= f64::EPSILON {
        0.0
    } else {
        ((curr_diag - prev_diag).abs() / prev_diag) as f32
    };

    let zoom_center_point = if previous.contains(current) {
        previous.center()
    } else {
        zoom_vanishing_point(current, previous).unwrap_or(previous.center())
    };

    analysis.movement_px = movement_px;
    analysis.movement_uv = movement_uv;
    analysis.movement_magnitude = movement_magnitude;
    analysis.zoom_magnitude = zoom_magnitude;
    analysis.zoom_center_uv = current.point_to_uv(zoom_center_point);
    analysis
}

fn zoom_vanishing_point(current: &MotionBounds, previous: &MotionBounds) -> Option<XY<f64>> {
    line_intersection(
        previous.top_left(),
        current.top_left(),
        previous.bottom_right(),
        current.bottom_right(),
    )
    .or_else(|| {
        line_intersection(
            previous.top_right(),
            current.top_right(),
            previous.bottom_left(),
            current.bottom_left(),
        )
    })
}

fn line_intersection(a1: XY<f64>, a2: XY<f64>, b1: XY<f64>, b2: XY<f64>) -> Option<XY<f64>> {
    let denom = (a1.x - a2.x) * (b1.y - b2.y) - (a1.y - a2.y) * (b1.x - b2.x);
    if denom.abs() <= f64::EPSILON {
        return None;
    }

    let a_det = a1.x * a2.y - a1.y * a2.x;
    let b_det = b1.x * b2.y - b1.y * b2.x;
    let x = (a_det * (b1.x - b2.x) - (a1.x - a2.x) * b_det) / denom;
    let y = (a_det * (b1.y - b2.y) - (a1.y - a2.y) * b_det) / denom;
    Some(XY::new(x, y))
}

fn clamp_vector(vec: XY<f32>, max_len: f32) -> XY<f32> {
    let len = (vec.x * vec.x + vec.y * vec.y).sqrt();
    if len <= max_len || len <= f32::EPSILON {
        vec
    } else {
        vec * (max_len / len)
    }
}

fn resolve_motion_descriptor(
    analysis: &MotionAnalysis,
    base_amount: f32,
    move_multiplier: f32,
    zoom_multiplier: f32,
) -> MotionBlurDescriptor {
    if base_amount <= f32::EPSILON {
        return MotionBlurDescriptor::none();
    }

    let zoom_metric = analysis.zoom_magnitude;
    let move_metric = analysis.movement_magnitude;
    let zoom_strength = (base_amount * zoom_multiplier).min(2.0);
    let move_strength = (base_amount * move_multiplier).min(2.0);

    if zoom_metric > move_metric && zoom_metric > MOTION_MIN_THRESHOLD && zoom_strength > 0.0 {
        let zoom_amount = (zoom_metric * zoom_strength).min(MAX_ZOOM_AMOUNT);
        MotionBlurDescriptor::zoom(analysis.zoom_center_uv, zoom_amount, zoom_strength)
    } else if move_metric > MOTION_MIN_THRESHOLD && move_strength > 0.0 {
        let vector = XY::new(
            analysis.movement_uv.x * move_strength,
            analysis.movement_uv.y * move_strength,
        );
        MotionBlurDescriptor::movement(clamp_vector(vector, MOTION_VECTOR_CAP), move_strength)
    } else {
        MotionBlurDescriptor::none()
    }
}

fn normalized_motion_amount(user_motion_blur: f32, fps: f32) -> f32 {
    if user_motion_blur <= f32::EPSILON {
        0.0
    } else {
        (user_motion_blur * (fps / MOTION_BLUR_BASELINE_FPS)).max(0.0)
    }
}

const CAMERA_PADDING: f32 = 50.0;

const SCREEN_MAX_PADDING: f64 = 0.4;

const MOTION_BLUR_BASELINE_FPS: f32 = 60.0;
const MOTION_MIN_THRESHOLD: f32 = 0.003;
const MOTION_VECTOR_CAP: f32 = 0.85;
const MAX_ZOOM_AMOUNT: f32 = 0.9;
const DISPLAY_MOVE_MULTIPLIER: f32 = 0.6;
const DISPLAY_ZOOM_MULTIPLIER: f32 = 0.45;
const CAMERA_MULTIPLIER: f32 = 1.0;
const CAMERA_ONLY_MULTIPLIER: f32 = 0.45;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MotionBlurMode {
    None,
    Movement,
    Zoom,
}

impl MotionBlurMode {
    fn as_f32(self) -> f32 {
        match self {
            MotionBlurMode::None => 0.0,
            MotionBlurMode::Movement => 1.0,
            MotionBlurMode::Zoom => 2.0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct MotionBlurDescriptor {
    mode: MotionBlurMode,
    strength: f32,
    movement_vector_uv: [f32; 2],
    zoom_center_uv: [f32; 2],
    zoom_amount: f32,
}

impl Default for MotionBlurDescriptor {
    fn default() -> Self {
        Self {
            mode: MotionBlurMode::None,
            strength: 0.0,
            movement_vector_uv: [0.0, 0.0],
            zoom_center_uv: [0.5, 0.5],
            zoom_amount: 0.0,
        }
    }
}

impl MotionBlurDescriptor {
    fn none() -> Self {
        Self::default()
    }

    fn movement(vector_uv: XY<f32>, strength: f32) -> Self {
        Self {
            mode: MotionBlurMode::Movement,
            strength,
            movement_vector_uv: [vector_uv.x, vector_uv.y],
            zoom_center_uv: [0.5, 0.5],
            zoom_amount: 0.0,
        }
    }

    fn zoom(center_uv: XY<f32>, zoom_amount: f32, strength: f32) -> Self {
        Self {
            mode: MotionBlurMode::Zoom,
            strength,
            movement_vector_uv: [0.0, 0.0],
            zoom_center_uv: [center_uv.x, center_uv.y],
            zoom_amount,
        }
    }
}

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

    pub fn get_base_size(options: &RenderOptions, project: &ProjectConfiguration) -> (u32, u32) {
        let crop = Self::get_crop(options, project);
        let crop_aspect = crop.aspect_ratio();

        match &project.aspect_ratio {
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
        }
    }

    pub fn get_output_size(
        options: &RenderOptions,
        project: &ProjectConfiguration,
        resolution_base: XY<u32>,
    ) -> (u32, u32) {
        let (base_width, base_height) = Self::get_base_size(options, project);

        let width_scale = resolution_base.x as f32 / base_width as f32;
        let height_scale = resolution_base.y as f32 / base_height as f32;
        let scale = width_scale.min(height_scale);

        let scaled_width = ((base_width as f32 * scale) as u32 + 3) & !3;
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
            let crop_basis = f64::max(cropped_size.x, cropped_size.y);
            let base_padding = crop_basis * padding_factor;

            let (base_w, base_h) = Self::get_base_size(options, project);
            let output_scale = f64::min(
                output_size.x / f64::max(base_w as f64, 1.0),
                output_size.y / f64::max(base_h as f64, 1.0),
            );
            base_padding * output_scale
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

    fn display_bounds(
        zoom: &InterpolatedZoom,
        display_offset: Coord<FrameSpace>,
        display_size: Coord<FrameSpace>,
        output_size: XY<f64>,
    ) -> (Coord<FrameSpace>, Coord<FrameSpace>) {
        let base_end = Coord::new(output_size) - display_offset;
        let zoom_start = Coord::new(zoom.bounds.top_left * display_size.coord);
        let zoom_end = Coord::new((zoom.bounds.bottom_right - 1.0) * display_size.coord);
        let start = display_offset + zoom_start;
        let end = base_end + zoom_end;
        (start, end)
    }

    fn compute_display_motion_blur(
        current: MotionBounds,
        previous: MotionBounds,
        has_previous: bool,
        base_amount: f32,
        extra_zoom: f32,
    ) -> MotionBlurComputation {
        if !has_previous || base_amount <= f32::EPSILON {
            return MotionBlurComputation::none();
        }

        let mut analysis = analyze_motion(&current, &previous);
        if extra_zoom > 0.0 {
            analysis.zoom_magnitude = (analysis.zoom_magnitude + extra_zoom).min(3.0);
        }

        let descriptor = resolve_motion_descriptor(
            &analysis,
            base_amount,
            DISPLAY_MOVE_MULTIPLIER,
            DISPLAY_ZOOM_MULTIPLIER,
        );
        let parent_vector = if analysis.movement_magnitude > MOTION_MIN_THRESHOLD {
            analysis.movement_px
        } else {
            XY::new(0.0, 0.0)
        };

        MotionBlurComputation {
            descriptor,
            parent_movement_px: parent_vector,
        }
    }

    fn camera_zoom_factor(
        zoom: &InterpolatedZoom,
        scene: &InterpolatedScene,
        base_size: f32,
        scale_during_zoom: f32,
    ) -> f32 {
        let t = zoom.t as f32;
        let zoomed_size = base_size * scale_during_zoom;
        let lerp = t * zoomed_size + (1.0 - t) * base_size;
        lerp * scene.camera_scale as f32
    }

    fn compute_camera_motion_blur(
        current: MotionBounds,
        previous: MotionBounds,
        has_previous: bool,
        base_amount: f32,
    ) -> MotionBlurDescriptor {
        if !has_previous || base_amount <= f32::EPSILON {
            return MotionBlurDescriptor::none();
        }

        let analysis = analyze_motion(&current, &previous);
        resolve_motion_descriptor(&analysis, base_amount, CAMERA_MULTIPLIER, CAMERA_MULTIPLIER)
    }

    #[allow(dead_code)]
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

    #[allow(clippy::too_many_arguments)]
    pub fn new(
        constants: &RenderVideoConstants,
        project: &ProjectConfiguration,
        frame_number: u32,
        fps: u32,
        resolution_base: XY<u32>,
        cursor_events: &CursorEvents,
        segment_frames: &DecodedSegmentFrames,
        total_duration: f64,
        zoom_focus_interpolator: &ZoomFocusInterpolator,
    ) -> Self {
        let options = &constants.options;
        let output_size = Self::get_output_size(options, project, resolution_base);
        let fps_f32 = fps as f32;
        let frame_time = frame_number as f32 / fps_f32;
        let prev_frame_time = if frame_number == 0 {
            0.0
        } else {
            (frame_number - 1) as f32 / fps_f32
        };
        let current_recording_time = segment_frames.recording_time;
        let prev_recording_time = (segment_frames.recording_time - 1.0 / fps_f32).max(0.0);

        let cursor_stop_time = project
            .cursor
            .stop_movement_in_last_seconds
            .map(|seconds| (total_duration - seconds as f64).max(0.0) as f32);

        let cursor_time_for_interp = if let Some(stop_time) = cursor_stop_time {
            current_recording_time.min(stop_time)
        } else {
            current_recording_time
        };

        let prev_cursor_time_for_interp = if let Some(stop_time) = cursor_stop_time {
            prev_recording_time.min(stop_time)
        } else {
            prev_recording_time
        };

        let cursor_motion_blur = project.cursor.motion_blur.clamp(0.0, 1.0);
        let screen_motion_blur = project.screen_motion_blur.clamp(0.0, 1.0);
        let has_previous = frame_number > 0;
        let normalized_screen_motion = normalized_motion_amount(screen_motion_blur, fps_f32);

        let crop = Self::get_crop(options, project);

        let cursor_smoothing = (!project.cursor.raw).then_some(SpringMassDamperSimulationConfig {
            tension: project.cursor.tension,
            mass: project.cursor.mass,
            friction: project.cursor.friction,
        });

        let interpolated_cursor =
            interpolate_cursor(cursor_events, cursor_time_for_interp, cursor_smoothing);

        let prev_interpolated_cursor =
            interpolate_cursor(cursor_events, prev_cursor_time_for_interp, cursor_smoothing);

        let zoom_segments = project
            .timeline
            .as_ref()
            .map(|t| t.zoom_segments.as_slice())
            .unwrap_or(&[]);

        let scene_segments = project
            .timeline
            .as_ref()
            .map(|t| t.scene_segments.as_slice())
            .unwrap_or(&[]);

        let zoom_focus = zoom_focus_interpolator.interpolate(current_recording_time);

        let prev_zoom_focus = zoom_focus_interpolator.interpolate(prev_recording_time);

        let actual_cursor_coord = interpolated_cursor
            .as_ref()
            .map(|c| Coord::<RawDisplayUVSpace>::new(c.position.coord));

        let prev_actual_cursor_coord = prev_interpolated_cursor
            .as_ref()
            .map(|c| Coord::<RawDisplayUVSpace>::new(c.position.coord));

        let zoom = InterpolatedZoom::new_with_cursor(
            SegmentsCursor::new(frame_time as f64, zoom_segments),
            zoom_focus,
            actual_cursor_coord,
        );

        let prev_zoom = InterpolatedZoom::new_with_cursor(
            SegmentsCursor::new(prev_frame_time as f64, zoom_segments),
            prev_zoom_focus,
            prev_actual_cursor_coord,
        );

        let scene =
            InterpolatedScene::new(SceneSegmentsCursor::new(frame_time as f64, scene_segments));
        let prev_scene = InterpolatedScene::new(SceneSegmentsCursor::new(
            prev_frame_time as f64,
            scene_segments,
        ));

        let (display, display_motion_parent) = {
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

            let (start, end) =
                Self::display_bounds(&zoom, display_offset, display_size, output_size);
            let (prev_start, prev_end) =
                Self::display_bounds(&prev_zoom, display_offset, display_size, output_size);

            let target_size = (end - start).coord;
            let min_target_axis = target_size.x.min(target_size.y);
            let scene_blur_strength = (scene.screen_blur as f32 * 0.8).min(1.2);

            let display_motion = Self::compute_display_motion_blur(
                MotionBounds::new(start, end),
                MotionBounds::new(prev_start, prev_end),
                has_previous,
                normalized_screen_motion,
                scene_blur_strength,
            );
            let descriptor = display_motion.descriptor;
            let display_parent_motion_px = display_motion.parent_movement_px;

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
                    rounding_type: rounding_type_value(project.background.rounding_type),
                    mirror_x: 0.0,
                    motion_blur_vector: descriptor.movement_vector_uv,
                    motion_blur_zoom_center: descriptor.zoom_center_uv,
                    motion_blur_params: [
                        descriptor.mode.as_f32(),
                        descriptor.strength,
                        descriptor.zoom_amount,
                        0.0,
                    ],
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
                    _padding1: [0.0; 4],
                    border_color: if let Some(b) = project.background.border.as_ref() {
                        [
                            b.color[0] as f32 / 255.0,
                            b.color[1] as f32 / 255.0,
                            b.color[2] as f32 / 255.0,
                            (b.opacity / 100.0).clamp(0.0, 1.0),
                        ]
                    } else {
                        [0.0, 0.0, 0.0, 0.0]
                    },
                },
                display_parent_motion_px,
            )
        };

        let camera = options
            .camera_size
            .filter(|_| !project.camera.hide && scene.should_render_camera())
            .map(|camera_size| {
                let output_size = [output_size.0 as f32, output_size.1 as f32];
                let frame_size = [camera_size.x as f32, camera_size.y as f32];
                let min_axis = output_size[0].min(output_size[1]);

                const BASE_HEIGHT: f32 = 1080.0;
                let resolution_scale = output_size[1] / BASE_HEIGHT;
                let camera_padding = CAMERA_PADDING * resolution_scale;

                let base_size = project.camera.size / 100.0;
                let scale_during_zoom = project.camera.scale_during_zoom;

                let zoomed_size =
                    Self::camera_zoom_factor(&zoom, &scene, base_size, scale_during_zoom);
                let prev_zoomed_size =
                    Self::camera_zoom_factor(&prev_zoom, &prev_scene, base_size, scale_during_zoom);

                let aspect = frame_size[0] / frame_size[1];
                let camera_size_for = |scale: f32| match project.camera.shape {
                    CameraShape::Source => {
                        if aspect >= 1.0 {
                            [
                                (min_axis * scale + camera_padding) * aspect,
                                min_axis * scale + camera_padding,
                            ]
                        } else {
                            [
                                min_axis * scale + camera_padding,
                                (min_axis * scale + camera_padding) / aspect,
                            ]
                        }
                    }
                    CameraShape::Square => [
                        min_axis * scale + camera_padding,
                        min_axis * scale + camera_padding,
                    ],
                };

                let size = camera_size_for(zoomed_size);
                let prev_size = camera_size_for(prev_zoomed_size);

                let position_for = |subject_size: [f32; 2]| {
                    let x = match &project.camera.position.x {
                        CameraXPosition::Left => camera_padding,
                        CameraXPosition::Center => output_size[0] / 2.0 - subject_size[0] / 2.0,
                        CameraXPosition::Right => output_size[0] - camera_padding - subject_size[0],
                    };
                    let y = match &project.camera.position.y {
                        CameraYPosition::Top => camera_padding,
                        CameraYPosition::Bottom => {
                            output_size[1] - subject_size[1] - camera_padding
                        }
                    };

                    [x, y]
                };

                let position = position_for(size);
                let prev_position = position_for(prev_size);

                let target_bounds = [
                    position[0],
                    position[1],
                    position[0] + size[0],
                    position[1] + size[1],
                ];
                let prev_target_bounds = [
                    prev_position[0],
                    prev_position[1],
                    prev_position[0] + prev_size[0],
                    prev_position[1] + prev_size[1],
                ];

                let current_bounds = MotionBounds::new(
                    Coord::new(XY::new(target_bounds[0] as f64, target_bounds[1] as f64)),
                    Coord::new(XY::new(target_bounds[2] as f64, target_bounds[3] as f64)),
                );
                let prev_bounds = MotionBounds::new(
                    Coord::new(XY::new(
                        prev_target_bounds[0] as f64,
                        prev_target_bounds[1] as f64,
                    )),
                    Coord::new(XY::new(
                        prev_target_bounds[2] as f64,
                        prev_target_bounds[3] as f64,
                    )),
                );

                let camera_descriptor = Self::compute_camera_motion_blur(
                    current_bounds,
                    prev_bounds,
                    has_previous,
                    normalized_screen_motion,
                );

                let crop_bounds = match project.camera.shape {
                    CameraShape::Source => [0.0, 0.0, frame_size[0], frame_size[1]],
                    CameraShape::Square => {
                        if frame_size[0] > frame_size[1] {
                            let offset = (frame_size[0] - frame_size[1]) / 2.0;
                            [offset, 0.0, frame_size[0] - offset, frame_size[1]]
                        } else {
                            let offset = (frame_size[1] - frame_size[0]) / 2.0;
                            [0.0, offset, frame_size[0], frame_size[1] - offset]
                        }
                    }
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
                    rounding_type: rounding_type_value(project.camera.rounding_type),
                    mirror_x: if project.camera.mirror { 1.0 } else { 0.0 },
                    motion_blur_vector: camera_descriptor.movement_vector_uv,
                    motion_blur_zoom_center: camera_descriptor.zoom_center_uv,
                    motion_blur_params: [
                        camera_descriptor.mode.as_f32(),
                        camera_descriptor.strength,
                        camera_descriptor.zoom_amount,
                        0.0,
                    ],
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
                    _padding1: [0.0; 4],
                    border_color: [0.0, 0.0, 0.0, 0.0],
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

                let camera_only_blur =
                    (scene.camera_only_blur as f32 * CAMERA_ONLY_MULTIPLIER).clamp(0.0, 1.0);
                let camera_only_descriptor = if camera_only_blur <= f32::EPSILON {
                    MotionBlurDescriptor::none()
                } else {
                    MotionBlurDescriptor::zoom(
                        XY::new(0.5, 0.5),
                        (camera_only_blur * 0.75).min(MAX_ZOOM_AMOUNT),
                        camera_only_blur,
                    )
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
                    rounding_type: rounding_type_value(project.camera.rounding_type),
                    mirror_x: if project.camera.mirror { 1.0 } else { 0.0 },
                    motion_blur_vector: camera_only_descriptor.movement_vector_uv,
                    motion_blur_zoom_center: camera_only_descriptor.zoom_center_uv,
                    motion_blur_params: [
                        camera_only_descriptor.mode.as_f32(),
                        camera_only_descriptor.strength,
                        camera_only_descriptor.zoom_amount,
                        0.0,
                    ],
                    shadow: 0.0,
                    shadow_size: 0.0,
                    shadow_opacity: 0.0,
                    shadow_blur: 0.0,
                    opacity: scene.camera_only_transition_opacity() as f32,
                    border_enabled: 0.0,
                    border_width: 0.0,
                    _padding1: [0.0; 4],
                    border_color: [0.0, 0.0, 0.0, 0.0],
                }
            });

        let masks = project
            .timeline
            .as_ref()
            .map(|timeline| {
                interpolate_masks(
                    XY::new(output_size.0, output_size.1),
                    frame_time as f64,
                    &timeline.mask_segments,
                )
            })
            .unwrap_or_default();

        let texts = project
            .timeline
            .as_ref()
            .map(|timeline| {
                prepare_texts(
                    XY::new(output_size.0, output_size.1),
                    frame_time as f64,
                    &timeline.text_segments,
                    &project.hidden_text_segments,
                )
            })
            .unwrap_or_default();

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
            frame_rate: fps,
            frame_number,
            prev_cursor: prev_interpolated_cursor,
            display_parent_motion_px: display_motion_parent,
            motion_blur_amount: cursor_motion_blur,
            masks,
            texts,
        }
    }
}

#[derive(Clone)]
pub struct DecodedSegmentFrames {
    pub screen_frame: DecodedFrame,
    pub camera_frame: Option<DecodedFrame>,
    pub segment_time: f32,
    pub recording_time: f32,
}

pub struct FrameRenderer<'a> {
    constants: &'a RenderVideoConstants,
    session: Option<RenderSession>,
    nv12_converter: Option<frame_pipeline::RgbaToNv12Converter>,
}

impl<'a> FrameRenderer<'a> {
    const MAX_RENDER_RETRIES: u32 = 3;

    pub fn new(constants: &'a RenderVideoConstants) -> Self {
        Self {
            constants,
            session: None,
            nv12_converter: None,
        }
    }

    pub fn reset_session(&mut self) {
        self.session = None;
    }

    pub async fn render(
        &mut self,
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        cursor: &CursorEvents,
        layers: &mut RendererLayers,
    ) -> Result<Option<RenderedFrame>, RenderingError> {
        let mut last_error = None;

        for attempt in 0..Self::MAX_RENDER_RETRIES {
            if attempt > 0 {
                tracing::warn!(
                    frame_number = uniforms.frame_number,
                    attempt = attempt + 1,
                    "Retrying frame render after GPU error"
                );
                self.reset_session();
                tokio::time::sleep(std::time::Duration::from_millis(100 * (attempt as u64 + 1)))
                    .await;
            }

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

            match produce_frame(
                self.constants,
                segment_frames.clone(),
                uniforms.clone(),
                cursor,
                layers,
                session,
            )
            .await
            {
                Ok(opt_frame) => return Ok(opt_frame),
                Err(RenderingError::BufferMapWaitingFailed) => {
                    tracing::warn!(
                        frame_number = uniforms.frame_number,
                        attempt = attempt + 1,
                        "GPU buffer mapping failed, will retry"
                    );
                    last_error = Some(RenderingError::BufferMapWaitingFailed);
                }
                Err(RenderingError::BufferMapFailed(e)) => {
                    tracing::warn!(
                        frame_number = uniforms.frame_number,
                        attempt = attempt + 1,
                        error = %e,
                        "GPU buffer async error, will retry"
                    );
                    last_error = Some(RenderingError::BufferMapFailed(e));
                }
                Err(e) => return Err(e),
            }
        }

        Err(last_error.unwrap_or(RenderingError::BufferMapWaitingFailed))
    }

    pub async fn render_immediate(
        &mut self,
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        cursor: &CursorEvents,
        layers: &mut RendererLayers,
    ) -> Result<RenderedFrame, RenderingError> {
        if let Some(frame) = self
            .render(segment_frames, uniforms, cursor, layers)
            .await?
        {
            return Ok(frame);
        }
        self.flush_pipeline()
            .await
            .unwrap_or(Err(RenderingError::BufferMapWaitingFailed))
    }

    pub async fn flush_pipeline(&mut self) -> Option<Result<RenderedFrame, RenderingError>> {
        if let Some(session) = &mut self.session {
            flush_pending_readback(session, &self.constants.device).await
        } else {
            None
        }
    }

    pub async fn render_immediate_nv12(
        &mut self,
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        cursor: &CursorEvents,
        layers: &mut RendererLayers,
    ) -> Result<frame_pipeline::Nv12RenderedFrame, RenderingError> {
        if let Some(frame) = self
            .render_nv12(segment_frames, uniforms, cursor, layers)
            .await?
        {
            return Ok(frame);
        }
        self.flush_pipeline_nv12()
            .await
            .unwrap_or(Err(RenderingError::BufferMapWaitingFailed))
    }

    pub async fn flush_pipeline_nv12(
        &mut self,
    ) -> Option<Result<frame_pipeline::Nv12RenderedFrame, RenderingError>> {
        let nv12_converter = self.nv12_converter.as_mut()?;
        let pending = nv12_converter.take_pending()?;
        Some(pending.wait(&self.constants.device).await)
    }

    pub async fn render_nv12(
        &mut self,
        segment_frames: DecodedSegmentFrames,
        uniforms: ProjectUniforms,
        cursor: &CursorEvents,
        layers: &mut RendererLayers,
    ) -> Result<Option<frame_pipeline::Nv12RenderedFrame>, RenderingError> {
        let mut last_error = None;

        for attempt in 0..Self::MAX_RENDER_RETRIES {
            if attempt > 0 {
                tracing::warn!(
                    frame_number = uniforms.frame_number,
                    attempt = attempt + 1,
                    "Retrying NV12 frame render after GPU error"
                );
                self.reset_session();
                self.nv12_converter = None;
                tokio::time::sleep(std::time::Duration::from_millis(100 * (attempt as u64 + 1)))
                    .await;
            }

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

            let nv12_converter = self.nv12_converter.get_or_insert_with(|| {
                frame_pipeline::RgbaToNv12Converter::new(&self.constants.device)
            });

            let mut encoder = self.constants.device.create_command_encoder(
                &(wgpu::CommandEncoderDescriptor {
                    label: Some("Render Encoder (NV12)"),
                }),
            );

            if let Err(e) = layers
                .prepare_with_encoder(
                    self.constants,
                    &uniforms,
                    &segment_frames,
                    cursor,
                    &mut encoder,
                )
                .await
            {
                last_error = Some(e);
                continue;
            }

            layers.render(
                &self.constants.device,
                &self.constants.queue,
                &mut encoder,
                session,
                &uniforms,
            );

            match finish_encoder_nv12(
                session,
                nv12_converter,
                &self.constants.device,
                &self.constants.queue,
                &uniforms,
                encoder,
            )
            .await
            {
                Ok(opt_frame) => return Ok(opt_frame),
                Err(RenderingError::BufferMapWaitingFailed) => {
                    last_error = Some(RenderingError::BufferMapWaitingFailed);
                }
                Err(RenderingError::BufferMapFailed(e)) => {
                    last_error = Some(RenderingError::BufferMapFailed(e));
                }
                Err(e) => return Err(e),
            }
        }

        Err(last_error.unwrap_or(RenderingError::BufferMapWaitingFailed))
    }
}

pub struct RendererLayers {
    background: BackgroundLayer,
    background_blur: BlurLayer,
    display: DisplayLayer,
    cursor: CursorLayer,
    camera: CameraLayer,
    camera_only: CameraLayer,
    mask: MaskLayer,
    text: TextLayer,
    captions: CaptionsLayer,
}

impl RendererLayers {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        Self::new_with_options(device, queue, false)
    }

    pub fn new_with_options(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        prefer_cpu_conversion: bool,
    ) -> Self {
        let shared_yuv_pipelines = Arc::new(yuv_converter::YuvConverterPipelines::new(device));
        let shared_composite_pipeline =
            Arc::new(composite_frame::CompositeVideoFramePipeline::new(device));

        Self {
            background: BackgroundLayer::new(device),
            background_blur: BlurLayer::new(device),
            display: DisplayLayer::new_with_all_shared_pipelines(
                device,
                shared_yuv_pipelines.clone(),
                shared_composite_pipeline.clone(),
                prefer_cpu_conversion,
            ),
            cursor: CursorLayer::new(device),
            camera: CameraLayer::new_with_all_shared_pipelines(
                device,
                shared_yuv_pipelines.clone(),
                shared_composite_pipeline.clone(),
            ),
            camera_only: CameraLayer::new_with_all_shared_pipelines(
                device,
                shared_yuv_pipelines,
                shared_composite_pipeline,
            ),
            mask: MaskLayer::new(device),
            text: TextLayer::new(device, queue),
            captions: CaptionsLayer::new(device, queue),
        }
    }

    pub fn prepare_for_video_dimensions(
        &mut self,
        device: &wgpu::Device,
        screen_width: u32,
        screen_height: u32,
        camera_width: Option<u32>,
        camera_height: Option<u32>,
    ) {
        tracing::info!(
            screen_width = screen_width,
            screen_height = screen_height,
            camera_width = camera_width,
            camera_height = camera_height,
            "Pre-allocating YUV converter textures for video dimensions"
        );
        self.display
            .prepare_for_video_dimensions(device, screen_width, screen_height);
        if let (Some(cw), Some(ch)) = (camera_width, camera_height) {
            self.camera.prepare_for_video_dimensions(device, cw, ch);
            self.camera_only
                .prepare_for_video_dimensions(device, cw, ch);
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
            uniforms.camera,
            constants.options.camera_size.and_then(|size| {
                segment_frames
                    .camera_frame
                    .as_ref()
                    .map(|frame| (size, frame, segment_frames.recording_time))
            }),
        );

        self.camera_only.prepare(
            &constants.device,
            &constants.queue,
            uniforms.camera_only,
            constants.options.camera_size.and_then(|size| {
                segment_frames
                    .camera_frame
                    .as_ref()
                    .map(|frame| (size, frame, segment_frames.recording_time))
            }),
        );

        self.text.prepare(
            &constants.device,
            &constants.queue,
            uniforms.output_size,
            &uniforms.texts,
        );

        self.captions.prepare(
            uniforms,
            segment_frames,
            XY::new(uniforms.output_size.0, uniforms.output_size.1),
            constants,
        );

        Ok(())
    }

    pub async fn prepare_with_encoder(
        &mut self,
        constants: &RenderVideoConstants,
        uniforms: &ProjectUniforms,
        segment_frames: &DecodedSegmentFrames,
        cursor: &CursorEvents,
        encoder: &mut wgpu::CommandEncoder,
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

        self.display.prepare_with_encoder(
            &constants.device,
            &constants.queue,
            segment_frames,
            constants.options.screen_size,
            uniforms.display,
            encoder,
        );

        self.cursor.prepare(
            segment_frames,
            uniforms.resolution_base,
            cursor,
            &uniforms.zoom,
            uniforms,
            constants,
        );

        self.camera.prepare_with_encoder(
            &constants.device,
            &constants.queue,
            uniforms.camera,
            constants.options.camera_size.and_then(|size| {
                segment_frames
                    .camera_frame
                    .as_ref()
                    .map(|frame| (size, frame, segment_frames.recording_time))
            }),
            encoder,
        );

        self.camera_only.prepare_with_encoder(
            &constants.device,
            &constants.queue,
            uniforms.camera_only,
            constants.options.camera_size.and_then(|size| {
                segment_frames
                    .camera_frame
                    .as_ref()
                    .map(|frame| (size, frame, segment_frames.recording_time))
            }),
            encoder,
        );

        self.text.prepare(
            &constants.device,
            &constants.queue,
            uniforms.output_size,
            &uniforms.texts,
        );

        self.captions.prepare(
            uniforms,
            segment_frames,
            XY::new(uniforms.output_size.0, uniforms.output_size.1),
            constants,
        );

        Ok(())
    }

    pub fn render(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
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

        self.display.copy_to_texture(encoder);
        self.camera.copy_to_texture(encoder);
        self.camera_only.copy_to_texture(encoder);

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

        let should_render = uniforms.scene.should_render_screen();

        if should_render {
            let mut pass = render_pass!(session.current_texture_view(), wgpu::LoadOp::Load);
            self.display.render(&mut pass);
        }

        if should_render {
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

        if !uniforms.masks.is_empty() {
            for mask in &uniforms.masks {
                self.mask.render(device, queue, session, encoder, mask);
            }
        }

        if !uniforms.texts.is_empty() {
            let mut pass = render_pass!(session.current_texture_view(), wgpu::LoadOp::Load);
            self.text.render(&mut pass);
        }

        if self.captions.has_content() {
            let mut pass = render_pass!(session.current_texture_view(), wgpu::LoadOp::Load);
            self.captions.render(&mut pass);
        }
    }
}

async fn produce_frame(
    constants: &RenderVideoConstants,
    segment_frames: DecodedSegmentFrames,
    uniforms: ProjectUniforms,
    cursor: &CursorEvents,
    layers: &mut RendererLayers,
    session: &mut RenderSession,
) -> Result<Option<RenderedFrame>, RenderingError> {
    let mut encoder = constants.device.create_command_encoder(
        &(wgpu::CommandEncoderDescriptor {
            label: Some("Render Encoder"),
        }),
    );

    layers
        .prepare_with_encoder(constants, &uniforms, &segment_frames, cursor, &mut encoder)
        .await?;

    layers.render(
        &constants.device,
        &constants.queue,
        &mut encoder,
        session,
        &uniforms,
    );

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
                format: wgpu::TextureFormat::Rgba8Unorm,
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
