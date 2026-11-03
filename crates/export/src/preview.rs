use std::{path::PathBuf, sync::Arc};

use base64::{Engine, engine::general_purpose::STANDARD};
use cap_editor::EditorInstance;
use cap_project::{CursorEvents, ProjectConfiguration, RecordingMeta, TimelineFrameMapping, XY};
use cap_rendering::{
    FrameRenderer, PrecomputedCursorTimeline, ProjectUniforms, RecordingSegmentDecoders,
    RenderVideoConstants, RenderedFrame, RendererLayers, TransitionRenderInput,
    ZoomTransformTimeline,
};
use image::{
    Rgba,
    codecs::jpeg::JpegEncoder,
    flat::{FlatSamples, SampleLayout},
};
use serde::{Deserialize, Serialize};

use crate::{
    ExportError, ExporterBase, ExporterBuilder, make_cursor_only_project,
    synthesize_default_timeline,
};

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
        .build_video_only()
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
            .build_video_only()
            .await
            .map_err(|error| ExportError::Other(format!("Exporter build error: {error}")))?;
    render_preview_with_base(exporter_base, frame_time, settings).await
}

/// Everything a preview frame needs, borrowed from whichever owner already
/// holds the decoders and GPU pipelines.
struct PreviewSource<'a> {
    project_config: &'a ProjectConfiguration,
    render_constants: &'a RenderVideoConstants,
    segments: Vec<PreviewSegment<'a>>,
    total_duration: f64,
    layers_cache: Option<&'a std::sync::Mutex<Option<RendererLayers>>>,
}

struct PreviewSegment<'a> {
    decoders: &'a RecordingSegmentDecoders,
    cursor: &'a CursorEvents,
}

async fn render_preview_with_base(
    exporter_base: ExporterBase,
    frame_time: f64,
    settings: ExportPreviewSettings,
) -> Result<ExportPreviewResult, ExportError> {
    let total_duration = cap_rendering::get_duration(
        &exporter_base.recordings,
        &exporter_base.recording_meta,
        &exporter_base.studio_meta,
        &exporter_base.project_config,
    );
    let source = PreviewSource {
        project_config: &exporter_base.project_config,
        render_constants: &exporter_base.render_constants,
        segments: exporter_base
            .segments
            .iter()
            .map(|segment| PreviewSegment {
                decoders: &segment.decoders,
                cursor: &segment.cursor,
            })
            .collect(),
        total_duration,
        layers_cache: None,
    };
    render_preview_frame(source, frame_time, settings).await
}

/// Render the preview through an open editor's decoders and GPU pipelines
/// instead of building a fresh exporter (a new wgpu device, every shader, and
/// a cold decoder per recording segment) for each frame. This is what makes the
/// export page's preview respond in one frame's worth of work rather than
/// seconds.
pub async fn render_preview_with_editor(
    editor: &EditorInstance,
    project_config: ProjectConfiguration,
    frame_time: f64,
    settings: ExportPreviewSettings,
) -> Result<ExportPreviewResult, ExportError> {
    let recording_meta = editor.meta();
    let studio_meta = recording_meta
        .studio_meta()
        .ok_or_else(|| ExportError::Other("Cannot preview non-studio recordings".to_string()))?;
    let mut project_config = project_config;
    if settings.cursor_only {
        project_config = make_cursor_only_project(project_config);
    }
    synthesize_default_timeline(&mut project_config, &editor.recordings);
    cap_project::synchronize_legacy_keyboard(recording_meta, &mut project_config);
    cap_project::synchronize_captions(
        &mut project_config,
        &editor
            .recordings
            .segments
            .iter()
            .map(|segment| segment.display.duration)
            .collect::<Vec<_>>(),
    );
    let total_duration = cap_rendering::get_duration(
        &editor.recordings,
        recording_meta,
        studio_meta,
        &project_config,
    );

    let _pause_prefetch = EditorPreviewGuard::new(editor);
    let source = PreviewSource {
        project_config: &project_config,
        render_constants: &editor.render_constants,
        segments: editor
            .segment_medias
            .iter()
            .map(|segment| PreviewSegment {
                decoders: &segment.decoders,
                cursor: &segment.cursor,
            })
            .collect(),
        total_duration,
        layers_cache: Some(&editor.preview_layers),
    };
    render_preview_frame(source, frame_time, settings).await
}

/// Holds the editor's `export_preview_active` flag so its idle prefetch does
/// not compete with the preview for the decoders.
struct EditorPreviewGuard<'a>(&'a EditorInstance);

impl<'a> EditorPreviewGuard<'a> {
    fn new(editor: &'a EditorInstance) -> Self {
        editor
            .export_preview_active
            .store(true, std::sync::atomic::Ordering::Release);
        Self(editor)
    }
}

impl Drop for EditorPreviewGuard<'_> {
    fn drop(&mut self) {
        self.0
            .export_preview_active
            .store(false, std::sync::atomic::Ordering::Release);
    }
}

async fn render_preview_frame(
    source: PreviewSource<'_>,
    frame_time: f64,
    settings: ExportPreviewSettings,
) -> Result<ExportPreviewResult, ExportError> {
    let PreviewSource {
        project_config,
        render_constants,
        segments,
        total_duration,
        layers_cache,
    } = source;
    let project_config = &Arc::new(project_config.clone());
    let transition_mapping = project_config.timeline.as_ref().and_then(|timeline| {
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
    let Some((segment_time, segment)) = project_config.get_segment_time(frame_time) else {
        return Err(ExportError::Other(
            "Frame time is outside video duration".to_string(),
        ));
    };

    let segment_media = segments
        .get(segment.recording_clip as usize)
        .ok_or_else(|| ExportError::Other("Recording clip is unavailable".to_string()))?;
    let clip_config = project_config
        .clips
        .iter()
        .find(|v| v.index == segment.recording_clip);

    let render_start = std::time::Instant::now();

    let segment_frames = segment_media
        .decoders
        .get_frames(
            segment_time as f32,
            project_config.requires_camera() && !settings.cursor_only,
            !settings.cursor_only,
            clip_config.map(|v| v.offsets).unwrap_or_default(),
        )
        .await
        .ok_or_else(|| ExportError::Other("Failed to decode frame".to_string()))?;

    let frame_number = (frame_time * settings.fps as f64).floor() as u32;

    let mut zoom_timeline = ZoomTransformTimeline::from_project_for_clip(
        project_config,
        segment_media.cursor,
        total_duration,
        render_constants.options.screen_size,
        segment.recording_clip,
    );
    zoom_timeline.ensure_precomputed_until((frame_number as f32 + 1.0) / settings.fps as f32);

    let cursor_timeline =
        PrecomputedCursorTimeline::from_project(segment_media.cursor, project_config);
    let uniforms = ProjectUniforms::new_with_precomputed_cursor(
        render_constants,
        project_config,
        frame_number,
        settings.fps,
        settings.resolution_base,
        segment_media.cursor,
        &segment_frames,
        total_duration,
        &zoom_timeline,
        &cursor_timeline,
    );

    let mut frame_renderer = FrameRenderer::new(render_constants);
    let mut layers = layers_cache
        .and_then(|cache| {
            let mut guard = cache.lock().ok()?;
            guard.take()
        })
        .map(|mut cached| {
            cached.reset_frame_state();
            cached
        })
        .unwrap_or_else(|| {
            RendererLayers::new_with_options(
                &render_constants.device,
                &render_constants.queue,
                render_constants.is_software_adapter,
            )
        });

    let frame = if let Some((outgoing, kind, progress)) = transition_mapping {
        let outgoing_media = segments
            .get(outgoing.segment.recording_clip as usize)
            .ok_or_else(|| {
                ExportError::Other("Outgoing recording clip is unavailable".to_string())
            })?;
        let outgoing_offsets = project_config
            .clips
            .iter()
            .find(|clip| clip.index == outgoing.segment.recording_clip)
            .map(|clip| clip.offsets)
            .unwrap_or_default();
        let outgoing_decoders = if outgoing.segment.recording_clip == segment.recording_clip {
            outgoing_media.decoders.transition_side().await
        } else {
            outgoing_media.decoders
        };
        let outgoing_frames = outgoing_decoders
            .get_frames(
                outgoing.source_time as f32,
                project_config.requires_camera() && !settings.cursor_only,
                !settings.cursor_only,
                outgoing_offsets,
            )
            .await
            .ok_or_else(|| ExportError::Other("Failed to decode outgoing frame".to_string()))?;
        let mut outgoing_zoom = ZoomTransformTimeline::from_project_for_outgoing_clip(
            project_config,
            outgoing_media.cursor,
            total_duration,
            render_constants.options.screen_size,
            outgoing.segment.recording_clip,
        );
        outgoing_zoom.ensure_precomputed_until((frame_number as f32 + 1.0) / settings.fps as f32);
        let outgoing_cursor_timeline = if outgoing.segment.recording_clip == segment.recording_clip
        {
            None
        } else {
            Some(PrecomputedCursorTimeline::from_project(
                outgoing_media.cursor,
                project_config,
            ))
        };
        let outgoing_uniforms = ProjectUniforms::new_with_precomputed_cursor(
            render_constants,
            project_config,
            frame_number,
            settings.fps,
            settings.resolution_base,
            outgoing_media.cursor,
            &outgoing_frames,
            total_duration,
            &outgoing_zoom,
            outgoing_cursor_timeline
                .as_ref()
                .unwrap_or(&cursor_timeline),
        );

        frame_renderer
            .render_transition_immediate(
                TransitionRenderInput {
                    segment_frames: outgoing_frames,
                    uniforms: outgoing_uniforms,
                    cursor: outgoing_media.cursor,
                    render_display: !settings.cursor_only,
                },
                TransitionRenderInput {
                    segment_frames,
                    uniforms,
                    cursor: segment_media.cursor,
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
                segment_media.cursor,
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

    if let Some(cache) = layers_cache
        && let Ok(mut guard) = cache.lock()
    {
        *guard = Some(layers);
    }

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
    fn immediate_export_preview_keeps_enabled_captions_regardless_of_legacy_export_toggle() {
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
            assert!(preview.captions.as_ref().unwrap().settings.enabled);
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

#[cfg(test)]
mod video_only_preview_tests {
    use super::*;

    fn studio_project() -> tempfile::TempDir {
        let project = tempfile::tempdir().unwrap();
        let generated = std::process::Command::new("ffmpeg")
            .args([
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=64x64:rate=15:duration=2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=2",
                "-map",
                "0:v",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-threads",
                "1",
            ])
            .arg(project.path().join("display.mp4"))
            .args(["-map", "1:a", "-c:a", "aac", "-ac", "2"])
            .arg(project.path().join("mic.m4a"))
            .output()
            .unwrap();
        assert!(generated.status.success(), "{generated:?}");
        std::fs::write(
            project.path().join("recording-meta.json"),
            serde_json::to_vec(&serde_json::json!({
                "pretty_name": "Video-only preview test",
                "segments": [{
                    "display": {"path": "display.mp4", "fps": 15},
                    "mic": {"path": "mic.m4a"}
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        ProjectConfiguration::default()
            .write(project.path())
            .unwrap();
        project
    }

    fn settings(cursor_only: bool) -> ExportPreviewSettings {
        ExportPreviewSettings {
            fps: 15,
            resolution_base: XY::new(64, 64),
            compression_bpp: 0.2,
            cursor_only,
        }
    }

    fn assert_same_preview(actual: ExportPreviewResult, expected: &ExportPreviewResult) {
        assert_eq!(actual.jpeg_base64, expected.jpeg_base64);
        assert_eq!(actual.actual_width, expected.actual_width);
        assert_eq!(actual.actual_height, expected.actual_height);
        assert_eq!(actual.total_frames, expected.total_frames);
        assert_eq!(
            actual.estimated_size_mb.to_bits(),
            expected.estimated_size_mb.to_bits()
        );
    }

    #[tokio::test]
    #[ignore = "requires ffmpeg and a wgpu adapter"]
    async fn video_only_previews_match_eager_jpeg_and_metadata() {
        let project = studio_project();
        for cursor_only in [false, true] {
            let config = ProjectConfiguration::load(project.path()).unwrap();
            let base = preview_builder_with_config(
                project.path().to_path_buf(),
                config.clone(),
                settings(cursor_only),
                true,
            )
            .build()
            .await
            .unwrap();
            let expected = render_preview_with_base(base, 0.5, settings(cursor_only))
                .await
                .unwrap();
            let actual = render_preview(
                project.path().to_path_buf(),
                0.5,
                settings(cursor_only),
                true,
            )
            .await
            .unwrap();
            assert_same_preview(actual, &expected);
            let actual = render_preview_with_config(
                project.path().to_path_buf(),
                config,
                0.5,
                settings(cursor_only),
                true,
            )
            .await
            .unwrap();
            assert_same_preview(actual, &expected);
        }
    }

    #[tokio::test]
    #[ignore = "requires ffmpeg, ffprobe and a wgpu adapter"]
    async fn preview_does_not_decode_unused_corrupt_audio() {
        let project = studio_project();
        let audio = project.path().join("mic.m4a");
        let expected = render_preview(project.path().to_path_buf(), 0.5, settings(false), true)
            .await
            .unwrap();
        let packets = std::process::Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_packets",
                "-show_entries",
                "packet=pts_time,pos,size",
                "-of",
                "json",
            ])
            .arg(&audio)
            .output()
            .unwrap();
        assert!(packets.status.success());
        let packets: serde_json::Value = serde_json::from_slice(&packets.stdout).unwrap();
        let packet = packets["packets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|packet| packet["pts_time"].as_str().unwrap().parse::<f64>().unwrap() > 1.5)
            .unwrap();
        let position: usize = packet["pos"].as_str().unwrap().parse().unwrap();
        let size: usize = packet["size"].as_str().unwrap().parse().unwrap();
        let mut bytes = std::fs::read(&audio).unwrap();
        bytes[position..position + size].fill(0xff);
        std::fs::write(audio, bytes).unwrap();
        let eager = ExporterBase::builder(project.path().to_path_buf())
            .with_force_ffmpeg_decoder(true)
            .build()
            .await;
        assert!(matches!(
            eager,
            Err(crate::ExporterBuildError::MediaLoad(_))
        ));
        let actual = render_preview(project.path().to_path_buf(), 0.5, settings(false), true)
            .await
            .unwrap();
        assert_same_preview(actual, &expected);
        let config = ProjectConfiguration::load(project.path()).unwrap();
        let actual = render_preview_with_config(
            project.path().to_path_buf(),
            config,
            0.5,
            settings(false),
            true,
        )
        .await
        .unwrap();
        assert_same_preview(actual, &expected);
    }
}
