use std::path::PathBuf;

use base64::{Engine, engine::general_purpose::STANDARD};
use cap_project::{ProjectConfiguration, RecordingMeta, TimelineFrameMapping, XY};
use cap_rendering::{
    FrameRenderer, ProjectUniforms, RenderedFrame, RendererLayers, TransitionRenderInput,
    ZoomTransformTimeline,
};
use image::{
    Rgba,
    codecs::jpeg::JpegEncoder,
    flat::{FlatSamples, SampleLayout},
};
use serde::{Deserialize, Serialize};

use crate::{ExportError, ExporterBase, ExporterBuilder, make_cursor_only_project};

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

fn preview_builder_with_config(
    project_path: PathBuf,
    project_config: ProjectConfiguration,
    settings: ExportPreviewSettings,
    force_ffmpeg_decoder: bool,
) -> ExporterBuilder {
    let project_config = if settings.cursor_only {
        make_cursor_only_project(project_config)
    } else {
        project_config
    };
    ExporterBase::builder(project_path)
        .with_config(project_config)
        .with_force_ffmpeg_decoder(force_ffmpeg_decoder)
}

pub async fn render_preview_with_config(
    project_path: PathBuf,
    project_config: ProjectConfiguration,
    frame_time: f64,
    settings: ExportPreviewSettings,
    force_ffmpeg_decoder: bool,
) -> Result<ExportPreviewResult, ExportError> {
    let exporter_base =
        preview_builder_with_config(project_path, project_config, settings, force_ffmpeg_decoder)
            .build()
            .await
            .map_err(|error| ExportError::Other(format!("Exporter build error: {error}")))?;
    render_preview_with_base(exporter_base, frame_time, settings).await
}

async fn render_preview_with_base(
    exporter_base: ExporterBase,
    frame_time: f64,
    settings: ExportPreviewSettings,
) -> Result<ExportPreviewResult, ExportError> {
    let transition_mapping = exporter_base
        .project_config
        .timeline
        .as_ref()
        .and_then(|timeline| {
            if timeline.transitions.is_empty() {
                return None;
            }
            match timeline.get_frame_mapping(frame_time) {
                Some(TimelineFrameMapping::Transition {
                    outgoing,
                    kind,
                    progress,
                    ..
                }) => Some((outgoing, kind, progress)),
                _ => None,
            }
        });
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
            exporter_base.project_config.requires_camera() && !settings.cursor_only,
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

    let mut zoom_timeline = ZoomTransformTimeline::from_project_for_clip(
        &exporter_base.project_config,
        &segment_media.cursor,
        total_duration,
        exporter_base.render_constants.options.screen_size,
        segment.recording_clip,
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

    let frame = if let Some((outgoing, kind, progress)) = transition_mapping {
        let outgoing_media = exporter_base
            .segments
            .get(outgoing.segment.recording_clip as usize)
            .ok_or_else(|| {
                ExportError::Other("Outgoing recording clip is unavailable".to_string())
            })?;
        let outgoing_offsets = exporter_base
            .project_config
            .clips
            .iter()
            .find(|clip| clip.index == outgoing.segment.recording_clip)
            .map(|clip| clip.offsets)
            .unwrap_or_default();
        let outgoing_frames = outgoing_media
            .decoders
            .get_frames(
                outgoing.source_time as f32,
                exporter_base.project_config.requires_camera() && !settings.cursor_only,
                !settings.cursor_only,
                outgoing_offsets,
            )
            .await
            .ok_or_else(|| ExportError::Other("Failed to decode outgoing frame".to_string()))?;
        let mut outgoing_zoom = ZoomTransformTimeline::from_project_for_outgoing_clip(
            &exporter_base.project_config,
            &outgoing_media.cursor,
            total_duration,
            exporter_base.render_constants.options.screen_size,
            outgoing.segment.recording_clip,
        );
        outgoing_zoom.ensure_precomputed_until((frame_number as f32 + 1.0) / settings.fps as f32);
        let outgoing_uniforms = ProjectUniforms::new(
            &exporter_base.render_constants,
            &exporter_base.project_config,
            frame_number,
            settings.fps,
            settings.resolution_base,
            &outgoing_media.cursor,
            &outgoing_frames,
            total_duration,
            &outgoing_zoom,
        );

        frame_renderer
            .render_transition_immediate(
                TransitionRenderInput {
                    segment_frames: outgoing_frames,
                    uniforms: outgoing_uniforms,
                    cursor: &outgoing_media.cursor,
                    render_display: !settings.cursor_only,
                },
                TransitionRenderInput {
                    segment_frames,
                    uniforms,
                    cursor: &segment_media.cursor,
                    render_display: !settings.cursor_only,
                },
                kind,
                progress as f32,
                &mut layers,
            )
            .await?
    } else {
        frame_renderer
            .render_immediate(
                segment_frames,
                uniforms,
                &segment_media.cursor,
                !settings.cursor_only,
                &mut layers,
            )
            .await?
    };

    let frame_render_time_ms = render_start.elapsed().as_secs_f64() * 1000.0;
    let width = frame.width;
    let height = frame.height;

    let jpeg_buffer = encode_preview_jpeg(&frame, bpp_to_jpeg_quality(settings.compression_bpp))?;
    drop(frame);

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

fn encode_preview_jpeg(frame: &RenderedFrame, quality: u8) -> Result<Vec<u8>, ExportError> {
    let width = usize::try_from(frame.width)
        .map_err(|_| ExportError::Other("Preview frame width is too large".to_string()))?;
    let height = usize::try_from(frame.height)
        .map_err(|_| ExportError::Other("Preview frame height is too large".to_string()))?;
    if width == 0 || height == 0 {
        return Err(ExportError::Other(
            "Preview frame dimensions must be non-zero".to_string(),
        ));
    }

    let row_bytes = width
        .checked_mul(4)
        .ok_or_else(|| ExportError::Other("Preview frame row is too large".to_string()))?;
    let height_stride = usize::try_from(frame.padded_bytes_per_row)
        .map_err(|_| ExportError::Other("Preview frame row stride is too large".to_string()))?;
    if height_stride < row_bytes {
        return Err(ExportError::Other("Preview frame rows overlap".to_string()));
    }
    let required_len = height_stride
        .checked_mul(height - 1)
        .and_then(|offset| offset.checked_add(row_bytes))
        .ok_or_else(|| ExportError::Other("Preview frame buffer is too large".to_string()))?;
    if frame.data.len() < required_len {
        return Err(ExportError::Other(
            "Preview frame buffer is shorter than its layout".to_string(),
        ));
    }

    let samples = FlatSamples {
        samples: frame.data.as_ref().as_slice(),
        layout: SampleLayout {
            channels: 4,
            channel_stride: 1,
            width: frame.width,
            width_stride: 4,
            height: frame.height,
            height_stride,
        },
        color_hint: None,
    };
    let view = samples
        .as_view::<Rgba<u8>>()
        .map_err(|e| ExportError::Other(format!("Invalid preview frame layout: {e}")))?;

    let mut jpeg_buffer = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_buffer, quality);
    encoder
        .encode_image(&view)
        .map_err(|e| ExportError::Other(format!("Failed to encode JPEG: {e}")))?;
    Ok(jpeg_buffer)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn frame(width: u32, height: u32, stride: usize, mut state: u64) -> RenderedFrame {
        let mut data = vec![0xa5; stride * height as usize];
        for y in 0..height as usize {
            for x in 0..width as usize {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let offset = y * stride + x * 4;
                data[offset] = (state >> 56) as u8;
                data[offset + 1] = (state >> 48) as u8;
                data[offset + 2] = (state >> 40) as u8;
                data[offset + 3] = (state >> 32) as u8;
            }
        }
        RenderedFrame {
            data: Arc::new(data),
            width,
            height,
            padded_bytes_per_row: stride as u32,
            frame_number: 0,
            target_time_ns: 0,
        }
    }

    fn legacy_jpeg(frame: &RenderedFrame, quality: u8) -> Vec<u8> {
        let rgb_data: Vec<u8> = frame
            .data
            .chunks(frame.padded_bytes_per_row as usize)
            .flat_map(|row| {
                row[..(frame.width * 4) as usize]
                    .chunks(4)
                    .flat_map(|chunk| [chunk[0], chunk[1], chunk[2]])
            })
            .collect();
        let mut jpeg_buffer = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_buffer, quality);
        encoder
            .encode(
                &rgb_data,
                frame.width,
                frame.height,
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        jpeg_buffer
    }

    #[test]
    fn flat_samples_jpeg_matches_legacy_bytes() {
        for (width, height, stride) in [(1, 1, 4), (13, 9, 64)] {
            let frame = frame(width, height, stride, 0x1234_5678_9abc_def0);
            for quality in [40, 70, 95] {
                assert_eq!(
                    encode_preview_jpeg(&frame, quality).unwrap(),
                    legacy_jpeg(&frame, quality),
                    "{width}x{height} stride={stride} quality={quality}"
                );
            }
        }

        let padded = frame(13, 9, 64, 0x1234_5678_9abc_def0);
        let required_len = 64 * (9 - 1) + 13 * 4;
        let mut without_trailing_padding = padded.clone();
        without_trailing_padding.data = Arc::new(padded.data[..required_len].to_vec());
        for quality in [40, 70, 95] {
            assert_eq!(
                encode_preview_jpeg(&without_trailing_padding, quality).unwrap(),
                legacy_jpeg(&without_trailing_padding, quality),
                "13x9 stride=64 without trailing padding quality={quality}"
            );
        }
    }

    #[test]
    fn rejects_overlapping_rows_and_short_buffers() {
        let mut overlapping = frame(13, 9, 64, 1);
        overlapping.padded_bytes_per_row = 51;
        assert!(encode_preview_jpeg(&overlapping, 70).is_err());

        let valid = frame(13, 9, 64, 2);
        let mut short = valid.clone();
        let required_len = 64 * (9 - 1) + 13 * 4;
        short.data = Arc::new(vec![0; required_len - 1]);
        assert!(encode_preview_jpeg(&short, 70).is_err());

        let mut empty = valid;
        empty.width = 0;
        assert!(encode_preview_jpeg(&empty, 70).is_err());
    }
}

#[cfg(test)]
mod subtitle_preview_tests {
    use super::*;

    #[test]
    fn immediate_export_preview_uses_current_toggle_before_disk_save() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("project-config.json");
        for export in [false, true] {
            let current = ProjectConfiguration {
                captions: Some(cap_project::CaptionsData {
                    settings: cap_project::CaptionSettings {
                        enabled: true,
                        export_with_subtitles: export,
                        ..Default::default()
                    },
                    ..Default::default()
                }),
                ..Default::default()
            };
            let original = serde_json::to_value(&current).unwrap();
            let mut stale = current.clone();
            stale
                .captions
                .as_mut()
                .unwrap()
                .settings
                .export_with_subtitles = !export;
            let stale_bytes = serde_json::to_vec(&stale).unwrap();
            std::fs::write(&path, &stale_bytes).unwrap();
            let mut builder = preview_builder_with_config(
                temp.path().to_path_buf(),
                current.clone(),
                ExportPreviewSettings {
                    fps: 30,
                    resolution_base: XY::new(1280, 720),
                    compression_bpp: 0.15,
                    cursor_only: false,
                },
                true,
            );
            let preview = builder.load_project_config().unwrap();
            assert_eq!(preview.captions.as_ref().unwrap().settings.enabled, export);
            assert_eq!(
                preview.captions.unwrap().settings.export_with_subtitles,
                export
            );
            assert_eq!(std::fs::read(&path).unwrap(), stale_bytes);
            assert_eq!(serde_json::to_value(current).unwrap(), original);
            assert!(builder.force_ffmpeg_decoder);
        }
    }

    #[test]
    fn current_config_export_preview_preserves_cursor_only_override() {
        let current = ProjectConfiguration {
            captions: Some(cap_project::CaptionsData {
                settings: cap_project::CaptionSettings {
                    enabled: true,
                    export_with_subtitles: true,
                    ..Default::default()
                },
                ..Default::default()
            }),
            ..Default::default()
        };
        let mut builder = preview_builder_with_config(
            PathBuf::from("unused-current-config-project"),
            current,
            ExportPreviewSettings {
                fps: 30,
                resolution_base: XY::new(1280, 720),
                compression_bpp: 0.15,
                cursor_only: true,
            },
            false,
        );
        assert!(builder.load_project_config().unwrap().captions.is_none());
    }
}
