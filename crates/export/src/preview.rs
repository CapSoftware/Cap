use std::path::PathBuf;

use base64::{Engine, engine::general_purpose::STANDARD};
use cap_project::{RecordingMeta, XY};
use cap_rendering::{FrameRenderer, ProjectUniforms, RendererLayers, ZoomTransformTimeline};
use image::codecs::jpeg::JpegEncoder;
use serde::{Deserialize, Serialize};

use crate::{ExportError, ExporterBase, make_cursor_only_project};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ExportPreviewSettings {
    pub fps: u32,
    pub resolution_base: XY<u32>,
    pub compression_bpp: f32,
    #[serde(default)]
    pub cursor_only: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportPreviewResult {
    pub jpeg_base64: String,
    pub estimated_size_mb: f64,
    pub actual_width: u32,
    pub actual_height: u32,
    pub frame_render_time_ms: f64,
    pub total_frames: u32,
}

pub async fn render_preview(
    project_path: PathBuf,
    frame_time: f64,
    settings: ExportPreviewSettings,
    force_ffmpeg_decoder: bool,
) -> Result<ExportPreviewResult, ExportError> {
    let mut exporter_builder =
        ExporterBase::builder(project_path.clone()).with_force_ffmpeg_decoder(force_ffmpeg_decoder);

    if settings.cursor_only {
        let meta = RecordingMeta::load_for_project(&project_path)
            .map_err(|e| ExportError::Other(format!("Failed to load recording meta: {e}")))?;
        exporter_builder =
            exporter_builder.with_config(make_cursor_only_project(meta.project_config()));
    }

    let exporter_base = exporter_builder
        .build()
        .await
        .map_err(|e| ExportError::Other(format!("Exporter build error: {e}")))?;

    render_preview_with_base(exporter_base, frame_time, settings).await
}

async fn render_preview_with_base(
    exporter_base: ExporterBase,
    frame_time: f64,
    settings: ExportPreviewSettings,
) -> Result<ExportPreviewResult, ExportError> {
    let Some((segment_time, segment)) = exporter_base.project_config.get_segment_time(frame_time)
    else {
        return Err(ExportError::Other(
            "Frame time is outside video duration".to_string(),
        ));
    };

    let segment_media = exporter_base
        .segments
        .get(segment.recording_clip as usize)
        .ok_or_else(|| ExportError::Other("Recording clip is unavailable".to_string()))?;
    let clip_config = exporter_base
        .project_config
        .clips
        .iter()
        .find(|v| v.index == segment.recording_clip);

    let render_start = std::time::Instant::now();

    let segment_frames = segment_media
        .decoders
        .get_frames(
            segment_time as f32,
            !exporter_base.project_config.camera.hide,
            !settings.cursor_only,
            clip_config.map(|v| v.offsets).unwrap_or_default(),
        )
        .await
        .ok_or_else(|| ExportError::Other("Failed to decode frame".to_string()))?;

    let frame_number = (frame_time * settings.fps as f64).floor() as u32;
    let total_duration = cap_rendering::get_duration(
        &exporter_base.recordings,
        &exporter_base.recording_meta,
        &exporter_base.studio_meta,
        &exporter_base.project_config,
    );

    let mut zoom_timeline = ZoomTransformTimeline::from_project(
        &exporter_base.project_config,
        &segment_media.cursor,
        total_duration,
    );
    zoom_timeline.ensure_precomputed_until((frame_number as f32 + 1.0) / settings.fps as f32);

    let uniforms = ProjectUniforms::new(
        &exporter_base.render_constants,
        &exporter_base.project_config,
        frame_number,
        settings.fps,
        settings.resolution_base,
        &segment_media.cursor,
        &segment_frames,
        total_duration,
        &zoom_timeline,
    );

    let mut frame_renderer = FrameRenderer::new(&exporter_base.render_constants);
    let mut layers = RendererLayers::new_with_options(
        &exporter_base.render_constants.device,
        &exporter_base.render_constants.queue,
        exporter_base.render_constants.is_software_adapter,
    );

    let frame = frame_renderer
        .render_immediate(
            segment_frames,
            uniforms,
            &segment_media.cursor,
            !settings.cursor_only,
            &mut layers,
        )
        .await?;

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

    let mut jpeg_buffer = Vec::new();
    {
        let mut encoder = JpegEncoder::new_with_quality(
            &mut jpeg_buffer,
            bpp_to_jpeg_quality(settings.compression_bpp),
        );
        encoder
            .encode(&rgb_data, width, height, image::ExtendedColorType::Rgb8)
            .map_err(|e| ExportError::Other(format!("Failed to encode JPEG: {e}")))?;
    }

    let duration_seconds = total_duration;
    let fps_f64 = settings.fps as f64;
    let total_frames = (duration_seconds * fps_f64).ceil() as u32;
    let total_pixels = (settings.resolution_base.x * settings.resolution_base.y) as f64;
    let estimated_size_mb = if settings.cursor_only {
        let total_frames_f64 = (duration_seconds * fps_f64).ceil();
        estimate_cursor_only_size_mb(total_pixels, total_frames_f64)
    } else {
        let effective_fps = ((fps_f64 - 30.0).max(0.0) * 0.6) + fps_f64.min(30.0);
        let video_bitrate = total_pixels * settings.compression_bpp as f64 * effective_fps;
        let audio_bitrate = 192_000.0;
        let total_bitrate = video_bitrate + audio_bitrate;
        let encoder_efficiency = 0.5;
        (total_bitrate * encoder_efficiency * duration_seconds) / (8.0 * 1024.0 * 1024.0)
    };

    Ok(ExportPreviewResult {
        jpeg_base64: STANDARD.encode(&jpeg_buffer),
        estimated_size_mb,
        actual_width: width,
        actual_height: height,
        frame_render_time_ms,
        total_frames,
    })
}

fn estimate_cursor_only_size_mb(total_pixels: f64, total_frames: f64) -> f64 {
    let bytes_per_frame = total_pixels * 0.4;
    (bytes_per_frame * total_frames) / (1024.0 * 1024.0)
}

fn bpp_to_jpeg_quality(bpp: f32) -> u8 {
    ((bpp - 0.04) / (0.3 - 0.04) * (95.0 - 40.0) + 40.0).clamp(40.0, 95.0) as u8
}
