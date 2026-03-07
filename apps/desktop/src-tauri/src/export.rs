use crate::editor_window::{OptionalWindowEditorInstance, WindowEditorInstance};
use crate::{FramesRendered, get_video_metadata};
use cap_export::ExporterBase;
use cap_project::{RecordingMeta, XY};
use cap_rendering::{
    FrameRenderer, ProjectRecordingsMeta, ProjectUniforms, RenderSegment, RenderVideoConstants,
    RendererLayers, ZoomFocusInterpolator, spring_mass_damper::SpringMassDamperSimulationConfig,
};
use image::codecs::jpeg::JpegEncoder;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tracing::{info, instrument};

struct ExportActiveGuard<'a>(&'a AtomicBool);

impl Drop for ExportActiveGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
        tracing::info!("Resuming editor preview after export");
    }
}

#[derive(Deserialize, Clone, Copy, Debug, Type)]
#[serde(tag = "format")]
pub enum ExportSettings {
    Mp4(cap_export::mp4::Mp4ExportSettings),
    Gif(cap_export::gif::GifExportSettings),
}

impl ExportSettings {
    fn fps(&self) -> u32 {
        match self {
            ExportSettings::Mp4(settings) => settings.fps,
            ExportSettings::Gif(settings) => settings.fps,
        }
    }
}

async fn do_export(
    project_path: &Path,
    settings: &ExportSettings,
    progress: &tauri::ipc::Channel<FramesRendered>,
    force_ffmpeg: bool,
) -> Result<PathBuf, String> {
    let exporter_base = ExporterBase::builder(project_path.to_path_buf())
        .with_force_ffmpeg_decoder(force_ffmpeg)
        .build()
        .await
        .map_err(|e| e.to_string())?;

    let total_frames = exporter_base.total_frames(settings.fps());

    let _ = progress.send(FramesRendered {
        rendered_count: 0,
        total_frames,
    });

    match settings {
        ExportSettings::Mp4(mp4_settings) => {
            let progress = progress.clone();
            mp4_settings
                .export(exporter_base, move |frame_index| {
                    progress
                        .send(FramesRendered {
                            rendered_count: (frame_index + 1).min(total_frames),
                            total_frames,
                        })
                        .is_ok()
                })
                .await
        }
        ExportSettings::Gif(gif_settings) => {
            let progress = progress.clone();
            gif_settings
                .export(exporter_base, move |frame_index| {
                    progress
                        .send(FramesRendered {
                            rendered_count: (frame_index + 1).min(total_frames),
                            total_frames,
                        })
                        .is_ok()
                })
                .await
        }
    }
}

fn is_frame_decode_error(error: &str) -> bool {
    error.contains("Failed to decode video frames")
        || error.contains("Too many consecutive frame failures")
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(progress, editor))]
pub async fn export_video(
    project_path: PathBuf,
    progress: tauri::ipc::Channel<FramesRendered>,
    settings: ExportSettings,
    editor: OptionalWindowEditorInstance,
) -> Result<PathBuf, String> {
    let force_ffmpeg = false;

    let _guard = if let Some(ref ed) = *editor {
        ed.export_active.store(true, Ordering::Release);
        tracing::info!("Pausing editor preview during export");
        Some(ExportActiveGuard(&ed.export_active))
    } else {
        None
    };

    let result = do_export(&project_path, &settings, &progress, force_ffmpeg).await;

    match result {
        Ok(path) => {
            info!("Exported to {} completed", path.display());
            Ok(path)
        }
        Err(e) if !force_ffmpeg && is_frame_decode_error(&e) => {
            info!(
                "Export failed with frame decode error, retrying with FFmpeg decoder: {}",
                e
            );

            let retry_result = do_export(&project_path, &settings, &progress, true).await;

            match retry_result {
                Ok(path) => {
                    info!(
                        "Export succeeded with FFmpeg decoder fallback: {}",
                        path.display()
                    );
                    Ok(path)
                }
                Err(retry_e) => {
                    sentry::capture_message(&retry_e, sentry::Level::Error);
                    Err(retry_e)
                }
            }
        }
        Err(e) => {
            sentry::capture_message(&e, sentry::Level::Error);
            Err(e)
        }
    }
}

#[derive(Debug, serde::Serialize, specta::Type)]
pub struct ExportEstimates {
    pub duration_seconds: f64,
    pub estimated_time_seconds: f64,
    pub estimated_size_mb: f64,
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn get_export_estimates(
    path: PathBuf,
    settings: ExportSettings,
) -> Result<ExportEstimates, String> {
    let metadata = get_video_metadata(path.clone()).await?;

    let meta = RecordingMeta::load_for_project(&path).map_err(|e| e.to_string())?;
    let project_config = meta.project_config();
    let duration_seconds = if let Some(timeline) = &project_config.timeline {
        timeline.segments.iter().map(|s| s.duration()).sum()
    } else {
        metadata.duration
    };

    let (resolution, fps) = match &settings {
        ExportSettings::Mp4(s) => (s.resolution_base, s.fps),
        ExportSettings::Gif(s) => (s.resolution_base, s.fps),
    };

    let (width, height) = (resolution.x, resolution.y);
    let total_pixels = (width * height) as f64;
    let fps_f64 = fps as f64;
    let total_frames = (duration_seconds * fps_f64).ceil();

    let (estimated_size_mb, estimated_time_seconds) = match &settings {
        ExportSettings::Mp4(mp4_settings) => {
            let bits_per_pixel = mp4_settings.compression.bits_per_pixel() as f64;
            let effective_fps = ((fps_f64 - 30.0).max(0.0) * 0.6) + fps_f64.min(30.0);
            let video_bitrate = total_pixels * bits_per_pixel * effective_fps;
            let audio_bitrate = 192_000.0;
            let total_bitrate = video_bitrate + audio_bitrate;
            let encoder_efficiency = 0.5;
            let size_mb =
                (total_bitrate * encoder_efficiency * duration_seconds) / (8.0 * 1024.0 * 1024.0);

            let effective_render_fps = match (width, height) {
                (w, _) if w >= 3840 => 175.0,
                _ => 290.0,
            };
            let time_estimate = total_frames / effective_render_fps;

            (size_mb, time_estimate)
        }
        ExportSettings::Gif(_) => {
            let bytes_per_frame = total_pixels * 0.5;
            let gif_efficiency = 0.07;
            let size_mb = (bytes_per_frame * gif_efficiency * total_frames) / (1024.0 * 1024.0);

            let frames_per_sec = match (width, height) {
                (w, h) if w <= 1280 && h <= 720 => 10.0,
                (w, h) if w <= 1920 && h <= 1080 => 5.0,
                _ => 2.0,
            };
            let time_estimate = total_frames / frames_per_sec;

            (size_mb, time_estimate)
        }
    };

    Ok(ExportEstimates {
        duration_seconds,
        estimated_time_seconds,
        estimated_size_mb,
    })
}

#[derive(Debug, Deserialize, Type)]
pub struct ExportPreviewSettings {
    pub fps: u32,
    pub resolution_base: XY<u32>,
    pub compression_bpp: f32,
}

#[derive(Debug, Serialize, Type)]
pub struct ExportPreviewResult {
    pub jpeg_base64: String,
    pub estimated_size_mb: f64,
    pub actual_width: u32,
    pub actual_height: u32,
    pub frame_render_time_ms: f64,
    pub total_frames: u32,
}

fn bpp_to_jpeg_quality(bpp: f32) -> u8 {
    ((bpp - 0.04) / (0.3 - 0.04) * (95.0 - 40.0) + 40.0).clamp(40.0, 95.0) as u8
}

#[tauri::command]
#[specta::specta]
#[instrument(skip_all)]
pub async fn generate_export_preview(
    project_path: PathBuf,
    frame_time: f64,
    settings: ExportPreviewSettings,
) -> Result<ExportPreviewResult, String> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use cap_editor::create_segments;
    use std::time::Instant;

    let recording_meta = RecordingMeta::load_for_project(&project_path)
        .map_err(|e| format!("Failed to load recording meta: {e}"))?;

    let cap_project::RecordingMetaInner::Studio(studio_meta) = &recording_meta.inner else {
        return Err("Cannot preview non-studio recordings".to_string());
    };

    let project_config = recording_meta.project_config();

    let recordings = Arc::new(
        ProjectRecordingsMeta::new(&recording_meta.project_path, studio_meta)
            .map_err(|e| format!("Failed to load recordings: {e}"))?,
    );

    let render_constants = Arc::new(
        RenderVideoConstants::new(
            &recordings.segments,
            recording_meta.clone(),
            (**studio_meta).clone(),
        )
        .await
        .map_err(|e| format!("Failed to create render constants: {e}"))?,
    );

    let segments = create_segments(&recording_meta, studio_meta, false)
        .await
        .map_err(|e| format!("Failed to create segments: {e}"))?;

    let render_segments: Vec<RenderSegment> = segments
        .iter()
        .map(|s| RenderSegment {
            cursor: s.cursor.clone(),
            keyboard: s.keyboard.clone(),
            decoders: s.decoders.clone(),
        })
        .collect();

    let Some((segment_time, segment)) = project_config.get_segment_time(frame_time) else {
        return Err("Frame time is outside video duration".to_string());
    };

    let render_segment = &render_segments[segment.recording_clip as usize];
    let clip_config = project_config
        .clips
        .iter()
        .find(|v| v.index == segment.recording_clip);

    let render_start = Instant::now();

    let segment_frames = render_segment
        .decoders
        .get_frames(
            segment_time as f32,
            !project_config.camera.hide,
            clip_config.map(|v| v.offsets).unwrap_or_default(),
        )
        .await
        .ok_or_else(|| "Failed to decode frame".to_string())?;

    let frame_number = (frame_time * settings.fps as f64).floor() as u32;
    let total_duration = project_config
        .timeline
        .as_ref()
        .map(|t| t.duration())
        .unwrap_or(0.0);

    let cursor_smoothing =
        (!project_config.cursor.raw).then_some(SpringMassDamperSimulationConfig {
            tension: project_config.cursor.tension,
            mass: project_config.cursor.mass,
            friction: project_config.cursor.friction,
        });

    let zoom_focus_interpolator = ZoomFocusInterpolator::new(
        &render_segment.cursor,
        cursor_smoothing,
        project_config.screen_movement_spring,
        total_duration,
    );

    let uniforms = ProjectUniforms::new(
        &render_constants,
        &project_config,
        frame_number,
        settings.fps,
        settings.resolution_base,
        &render_segment.cursor,
        &segment_frames,
        total_duration,
        &zoom_focus_interpolator,
    );

    let mut frame_renderer = FrameRenderer::new(&render_constants);
    let mut layers = RendererLayers::new_with_options(
        &render_constants.device,
        &render_constants.queue,
        render_constants.is_software_adapter,
    );

    let frame = frame_renderer
        .render_immediate(
            segment_frames,
            uniforms,
            &render_segment.cursor,
            &mut layers,
        )
        .await
        .map_err(|e| format!("Failed to render frame: {e}"))?;

    let frame_render_time_ms = render_start.elapsed().as_secs_f64() * 1000.0;

    let width = frame.width;
    let height = frame.height;

    let rgb_data: Vec<u8> = frame
        .data
        .chunks(frame.padded_bytes_per_row as usize)
        .flat_map(|row| {
            row[0..(frame.width * 4) as usize]
                .chunks(4)
                .flat_map(|chunk| [chunk[0], chunk[1], chunk[2]])
        })
        .collect();

    let jpeg_quality = bpp_to_jpeg_quality(settings.compression_bpp);
    let mut jpeg_buffer = Vec::new();
    {
        let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_buffer, jpeg_quality);
        encoder
            .encode(&rgb_data, width, height, image::ExtendedColorType::Rgb8)
            .map_err(|e| format!("Failed to encode JPEG: {e}"))?;
    }

    let jpeg_base64 = STANDARD.encode(&jpeg_buffer);

    let total_pixels = (settings.resolution_base.x * settings.resolution_base.y) as f64;
    let fps_f64 = settings.fps as f64;

    let metadata = get_video_metadata(project_path.clone()).await?;
    let duration_seconds = if let Some(timeline) = &project_config.timeline {
        timeline.segments.iter().map(|s| s.duration()).sum()
    } else {
        metadata.duration
    };
    let total_frames = (duration_seconds * fps_f64).ceil() as u32;

    let effective_fps = ((fps_f64 - 30.0).max(0.0) * 0.6) + fps_f64.min(30.0);
    let video_bitrate = total_pixels * settings.compression_bpp as f64 * effective_fps;
    let audio_bitrate = 192_000.0;
    let total_bitrate = video_bitrate + audio_bitrate;
    let encoder_efficiency = 0.5;
    let estimated_size_mb =
        (total_bitrate * encoder_efficiency * duration_seconds) / (8.0 * 1024.0 * 1024.0);

    Ok(ExportPreviewResult {
        jpeg_base64,
        estimated_size_mb,
        actual_width: width,
        actual_height: height,
        frame_render_time_ms,
        total_frames,
    })
}

#[tauri::command]
#[specta::specta]
#[instrument(skip_all)]
pub async fn generate_export_preview_fast(
    editor: WindowEditorInstance,
    frame_time: f64,
    settings: ExportPreviewSettings,
) -> Result<ExportPreviewResult, String> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use std::time::Instant;

    if editor.export_active.load(Ordering::Acquire) {
        return Err("Export is in progress - preview generation skipped".to_string());
    }

    let project_config = editor.project_config.1.borrow().clone();

    let Some((segment_time, segment)) = project_config.get_segment_time(frame_time) else {
        return Err("Frame time is outside video duration".to_string());
    };

    let segment_media = &editor.segment_medias[segment.recording_clip as usize];
    let clip_config = project_config
        .clips
        .iter()
        .find(|v| v.index == segment.recording_clip);

    let render_start = Instant::now();

    editor.export_preview_active.store(true, Ordering::Release);
    let segment_frames = segment_media
        .decoders
        .get_frames(
            segment_time as f32,
            !project_config.camera.hide,
            clip_config.map(|v| v.offsets).unwrap_or_default(),
        )
        .await;
    editor.export_preview_active.store(false, Ordering::Release);
    let segment_frames = segment_frames.ok_or_else(|| "Failed to decode frame".to_string())?;

    let frame_number = (frame_time * settings.fps as f64).floor() as u32;
    let total_duration = project_config
        .timeline
        .as_ref()
        .map(|t| t.duration())
        .unwrap_or(0.0);

    let cursor_smoothing =
        (!project_config.cursor.raw).then_some(SpringMassDamperSimulationConfig {
            tension: project_config.cursor.tension,
            mass: project_config.cursor.mass,
            friction: project_config.cursor.friction,
        });

    let zoom_focus_interpolator = ZoomFocusInterpolator::new(
        &segment_media.cursor,
        cursor_smoothing,
        project_config.screen_movement_spring,
        total_duration,
    );

    let uniforms = ProjectUniforms::new(
        &editor.render_constants,
        &project_config,
        frame_number,
        settings.fps,
        settings.resolution_base,
        &segment_media.cursor,
        &segment_frames,
        total_duration,
        &zoom_focus_interpolator,
    );

    let mut frame_renderer = FrameRenderer::new(&editor.render_constants);
    let mut layers = RendererLayers::new_with_options(
        &editor.render_constants.device,
        &editor.render_constants.queue,
        editor.render_constants.is_software_adapter,
    );

    let frame = frame_renderer
        .render_immediate(segment_frames, uniforms, &segment_media.cursor, &mut layers)
        .await
        .map_err(|e| format!("Failed to render frame: {e}"))?;

    let frame_render_time_ms = render_start.elapsed().as_secs_f64() * 1000.0;

    let width = frame.width;
    let height = frame.height;

    let rgb_data: Vec<u8> = frame
        .data
        .chunks(frame.padded_bytes_per_row as usize)
        .flat_map(|row| {
            row[0..(frame.width * 4) as usize]
                .chunks(4)
                .flat_map(|chunk| [chunk[0], chunk[1], chunk[2]])
        })
        .collect();

    let jpeg_quality = bpp_to_jpeg_quality(settings.compression_bpp);
    let mut jpeg_buffer = Vec::new();
    {
        let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_buffer, jpeg_quality);
        encoder
            .encode(&rgb_data, width, height, image::ExtendedColorType::Rgb8)
            .map_err(|e| format!("Failed to encode JPEG: {e}"))?;
    }

    let jpeg_base64 = STANDARD.encode(&jpeg_buffer);

    let total_pixels = (settings.resolution_base.x * settings.resolution_base.y) as f64;
    let fps_f64 = settings.fps as f64;

    let duration_seconds = editor.recordings.duration();
    let total_frames = (duration_seconds * fps_f64).ceil() as u32;

    let effective_fps = ((fps_f64 - 30.0).max(0.0) * 0.6) + fps_f64.min(30.0);
    let video_bitrate = total_pixels * settings.compression_bpp as f64 * effective_fps;
    let audio_bitrate = 192_000.0;
    let total_bitrate = video_bitrate + audio_bitrate;
    let encoder_efficiency = 0.5;
    let estimated_size_mb =
        (total_bitrate * encoder_efficiency * duration_seconds) / (8.0 * 1024.0 * 1024.0);

    Ok(ExportPreviewResult {
        jpeg_base64,
        estimated_size_mb,
        actual_width: width,
        actual_height: height,
        frame_render_time_ms,
        total_frames,
    })
}
