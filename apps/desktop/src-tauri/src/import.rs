use cap_enc_ffmpeg::{
    AudioEncoder,
    h264::{H264EncoderBuilder, H264Preset},
    opus::OpusEncoder,
    remux::{get_media_duration, probe_video_can_decode},
};
use cap_media_info::{AudioInfo, FFRational, Pixel, VideoInfo, ensure_even};
use cap_project::{
    AudioMeta, ClipConfiguration, Cursors, InstantRecordingMeta, MultipleSegment, MultipleSegments,
    Platform, ProjectConfiguration, RecordingMeta, RecordingMetaInner, SingleSegment,
    StudioRecordingMeta, StudioRecordingStatus, TimelineConfiguration, TimelineSegment, VideoMeta,
};
use ffmpeg::{
    ChannelLayout,
    codec::{self as avcodec},
    format::{self as avformat},
};
use image::ImageEncoder;
use relative_path::RelativePathBuf;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    path::{Path, PathBuf},
    str::FromStr,
};
use tauri::{AppHandle, Manager, Window};
use tauri_specta::Event;
use tracing::{debug, error, info};

use crate::{
    create_screenshot,
    editor_window::EditorInstances,
    windows::{CapWindowId, EditorWindowIds},
};

const VIDEO_IMPORT_EXTENSIONS: &[&str] = &["mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v", "flv"];
const IMAGE_IMPORT_EXTENSIONS: &[&str] =
    &["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];
const MAX_IMAGE_DIMENSION: u32 = 16_384;

#[derive(Serialize, Deserialize, Type, Clone, Debug)]
pub enum ImportStage {
    Probing,
    Converting,
    Finalizing,
    Complete,
    Failed,
}

#[derive(Serialize, Deserialize, Type, tauri_specta::Event, Clone, Debug)]
pub struct VideoImportProgress {
    pub project_path: String,
    pub stage: ImportStage,
    pub progress: f64,
    pub message: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("Failed to open video file: {0}")]
    OpenFailed(String),
    #[error("No video stream found in file")]
    NoVideoStream,
    #[error("Failed to create decoder: {0}")]
    DecoderFailed(String),
    #[error("Failed to create encoder: {0}")]
    EncoderFailed(String),
    #[error("Failed to create project directory: {0}")]
    DirectoryFailed(std::io::Error),
    #[error("FFmpeg error: {0}")]
    Ffmpeg(#[from] ffmpeg::Error),
    #[error("Transcoding failed: {0}")]
    TranscodeFailed(String),
}

fn emit_progress(
    app: &AppHandle,
    project_path: &str,
    stage: ImportStage,
    progress: f64,
    message: &str,
) {
    let _ = VideoImportProgress {
        project_path: project_path.to_string(),
        stage,
        progress,
        message: message.to_string(),
    }
    .emit(app);
}

fn check_project_exists(project_path: &Path) -> bool {
    project_path.exists() && project_path.join("recording-meta.json").exists()
}

fn generate_project_name(source_path: &Path) -> String {
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported Video");

    let now = chrono::Local::now();
    let date_str = now.format("%Y-%m-%d at %H.%M.%S").to_string();

    format!("{stem} {date_str}")
}

fn generate_image_project_name(source_path: &Path) -> String {
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported Image");

    let now = chrono::Local::now();
    let date_str = now.format("%Y-%m-%d at %H.%M.%S").to_string();

    format!("{stem} {date_str}")
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

fn has_supported_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|ext| {
            extensions
                .iter()
                .any(|candidate| ext.eq_ignore_ascii_case(candidate))
        })
}

pub fn is_supported_video_import_path(path: &Path) -> bool {
    path.is_file() && has_supported_extension(path, VIDEO_IMPORT_EXTENSIONS)
}

pub fn is_supported_image_import_path(path: &Path) -> bool {
    path.is_file() && has_supported_extension(path, IMAGE_IMPORT_EXTENSIONS)
}

fn is_mp4_import_path(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
}

fn is_cap_project_path(path: &Path) -> bool {
    path.is_dir() && path.join("recording-meta.json").is_file()
}

fn editor_project_path_from_window(window: &Window) -> Result<PathBuf, String> {
    let CapWindowId::Editor { id } =
        CapWindowId::from_str(window.label()).map_err(|e| e.to_string())?
    else {
        return Err("Import can only be started from an editor window".to_string());
    };

    let window_ids = EditorWindowIds::get(window.app_handle());
    let window_ids = window_ids
        .ids
        .lock()
        .map_err(|_| "Editor window registry unavailable".to_string())?;

    window_ids
        .iter()
        .find(|(_, window_id)| *window_id == id)
        .map(|(path, _)| path.clone())
        .ok_or_else(|| "Editor project path not found".to_string())
}

fn same_project_path(a: &Path, b: &Path) -> bool {
    let a = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let b = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    a == b
}

fn ensure_multiple_segments(meta: &mut RecordingMeta) -> Result<&mut MultipleSegments, String> {
    let RecordingMetaInner::Studio(studio_meta) = &mut meta.inner else {
        return Err("Instant mode recordings cannot be edited".to_string());
    };

    if let StudioRecordingMeta::SingleSegment { segment } = studio_meta.as_ref() {
        let segment = segment.clone();
        **studio_meta = StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments: vec![MultipleSegment {
                    display: segment.display,
                    camera: segment.camera,
                    mic: segment.audio,
                    system_audio: None,
                    cursor: segment.cursor,
                    keyboard: None,
                    display_notch: None,
                }],
                cursors: Cursors::default(),
                status: Some(StudioRecordingStatus::Complete),
            },
        };
    }

    match studio_meta.as_mut() {
        StudioRecordingMeta::MultipleSegments { inner } => Ok(inner),
        StudioRecordingMeta::SingleSegment { .. } => {
            Err("Failed to normalize project recording segments".to_string())
        }
    }
}

fn get_video_duration_secs(path: &Path) -> Result<f64, String> {
    get_media_duration(path)
        .map(|duration| duration.as_secs_f64())
        .ok_or_else(|| format!("Could not determine video duration: {}", path.display()))
}

fn full_timeline_for_segments(
    project_path: &Path,
    segments: &[MultipleSegment],
) -> Result<Vec<TimelineSegment>, String> {
    segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            let duration = get_video_duration_secs(&segment.display.path.to_path(project_path))?;
            Ok(TimelineSegment {
                recording_clip: index as u32,
                timescale: 1.0,
                start: 0.0,
                end: duration,
                name: None,
                speed_audio_mode: None,
                hide_cursor: None,
                volume: None,
            })
        })
        .collect()
}

fn ensure_project_timeline<'a>(
    config: &'a mut ProjectConfiguration,
    project_path: &Path,
    segments: &[MultipleSegment],
) -> Result<&'a mut TimelineConfiguration, String> {
    if config.timeline.is_none() {
        config.timeline = Some(TimelineConfiguration {
            segments: full_timeline_for_segments(project_path, segments)?,
            transitions: Vec::new(),
            zoom_segments: Vec::new(),
            scene_segments: Vec::new(),
            style_segments: Vec::new(),
            image_segments: Vec::new(),
            mask_segments: Vec::new(),
            text_segments: Vec::new(),
            caption_segments: Vec::new(),
            keyboard_segments: Vec::new(),
            audio_segments: Vec::new(),
            camera3d_segments: Vec::new(),
        });
    }

    config
        .timeline
        .as_mut()
        .ok_or_else(|| "Failed to prepare project timeline".to_string())
}

fn add_clip_configs(
    config: &mut ProjectConfiguration,
    base_index: u32,
    segments: &[MultipleSegment],
) {
    for (offset, segment) in segments.iter().enumerate() {
        let index = base_index + offset as u32;
        let offsets = segment.calculate_audio_offsets();

        if let Some(existing) = config.clips.iter_mut().find(|clip| clip.index == index) {
            existing.offsets = offsets;
            existing.offsets_auto_calculated = true;
        } else {
            config.clips.push(ClipConfiguration {
                index,
                offsets,
                offsets_auto_calculated: true,
            });
        }
    }
}

fn unique_segment_dir(
    project_path: &Path,
    index: u32,
) -> Result<(PathBuf, String), std::io::Error> {
    let segments_root = project_path.join("content").join("segments");
    std::fs::create_dir_all(&segments_root)?;

    let mut counter = 0;
    loop {
        let name = if counter == 0 {
            format!("segment-{index}")
        } else {
            format!("segment-{index}-import-{counter}")
        };
        let path = segments_root.join(&name);
        if !path.exists() {
            std::fs::create_dir_all(&path)?;
            return Ok((path, format!("content/segments/{name}")));
        }
        counter += 1;
    }
}

fn get_video_stream_info(
    input: &avformat::context::Input,
) -> Result<(usize, VideoInfo), ImportError> {
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or(ImportError::NoVideoStream)?;

    let stream_index = stream.index();
    let decoder_ctx = avcodec::Context::from_parameters(stream.parameters())
        .map_err(|e| ImportError::DecoderFailed(e.to_string()))?;
    let decoder = decoder_ctx
        .decoder()
        .video()
        .map_err(|e| ImportError::DecoderFailed(e.to_string()))?;

    let rate = stream.avg_frame_rate();
    let time_base = stream.time_base();

    let pixel_format = match decoder.format() {
        ffmpeg::format::Pixel::YUV420P => Pixel::YUV420P,
        ffmpeg::format::Pixel::NV12 => Pixel::NV12,
        ffmpeg::format::Pixel::BGRA => Pixel::BGRA,
        ffmpeg::format::Pixel::RGBA => Pixel::RGBA,
        ffmpeg::format::Pixel::RGB24 => Pixel::RGB24,
        ffmpeg::format::Pixel::BGR24 => Pixel::BGR24,
        _ => Pixel::YUV420P,
    };

    Ok((
        stream_index,
        VideoInfo {
            pixel_format,
            width: decoder.width(),
            height: decoder.height(),
            time_base: FFRational(time_base.numerator(), time_base.denominator()),
            frame_rate: FFRational(rate.numerator(), rate.denominator()),
        },
    ))
}

fn get_audio_stream_info(input: &avformat::context::Input) -> Option<(usize, AudioInfo)> {
    let stream = input.streams().best(ffmpeg::media::Type::Audio)?;
    let stream_index = stream.index();

    let decoder_ctx = avcodec::Context::from_parameters(stream.parameters()).ok()?;
    let decoder = decoder_ctx.decoder().audio().ok()?;

    let audio_info = AudioInfo::from_decoder(&decoder).ok()?;

    Some((stream_index, audio_info))
}

fn reference_video_frame(frame: &ffmpeg::frame::Video) -> ffmpeg::frame::Video {
    let mut referenced = ffmpeg::frame::Video::empty();
    let status = unsafe { ffmpeg::ffi::av_frame_ref(referenced.as_mut_ptr(), frame.as_ptr()) };

    if status < 0 {
        frame.clone()
    } else {
        referenced
    }
}

fn transcode_video(
    app: &AppHandle,
    source_path: &Path,
    output_path: &Path,
    audio_output_path: Option<&Path>,
    project_path_str: &str,
    project_path: &Path,
) -> Result<(u32, Option<u32>), ImportError> {
    use std::time::Duration as StdDuration;

    let mut input =
        avformat::input(source_path).map_err(|e| ImportError::OpenFailed(e.to_string()))?;

    let (video_stream_index, video_info) = get_video_stream_info(&input)?;
    let audio_stream_info = get_audio_stream_info(&input);

    let output_width = ensure_even(video_info.width);
    let output_height = ensure_even(video_info.height);
    let fps = if video_info.frame_rate.1 > 0 {
        ((video_info.frame_rate.0 as f64 / video_info.frame_rate.1 as f64).round() as u32)
            .clamp(1, 120)
    } else {
        30
    };

    let duration = get_media_duration(source_path);
    let total_frames = duration
        .map(|d| (d.as_secs_f64() * fps as f64) as u64)
        .unwrap_or(1000);

    let video_decoder_ctx =
        avcodec::Context::from_parameters(input.stream(video_stream_index).unwrap().parameters())
            .map_err(|e| ImportError::DecoderFailed(e.to_string()))?;
    let mut video_decoder = video_decoder_ctx
        .decoder()
        .video()
        .map_err(|e| ImportError::DecoderFailed(e.to_string()))?;

    let video_time_base = input.stream(video_stream_index).unwrap().time_base();

    let mut audio_decoder = audio_stream_info.as_ref().and_then(|(idx, _)| {
        let stream = input.stream(*idx)?;
        let decoder_ctx = avcodec::Context::from_parameters(stream.parameters()).ok()?;
        let mut decoder = decoder_ctx.decoder().audio().ok()?;
        if decoder.channel_layout().is_empty() {
            decoder.set_channel_layout(ChannelLayout::default(decoder.channels() as i32));
        }
        decoder.set_packet_time_base(stream.time_base());
        Some((*idx, decoder, stream.time_base()))
    });

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(ImportError::DirectoryFailed)?;
    }

    let mut output =
        avformat::output(output_path).map_err(|e| ImportError::EncoderFailed(e.to_string()))?;

    let encoder_video_info = VideoInfo {
        pixel_format: Pixel::YUV420P,
        width: output_width,
        height: output_height,
        time_base: video_info.time_base,
        frame_rate: FFRational(fps as i32, 1),
    };

    let mut video_encoder = H264EncoderBuilder::new(encoder_video_info)
        .with_preset(H264Preset::Medium)
        .with_output_size(output_width, output_height)
        .map_err(|e| ImportError::EncoderFailed(e.to_string()))?
        .build(&mut output)
        .map_err(|e| ImportError::EncoderFailed(e.to_string()))?;

    let mut audio_output: Option<avformat::context::Output> = None;
    let mut audio_encoder: Option<Box<dyn AudioEncoder + Send>> = None;
    let sample_rate = if let Some((_, audio_info)) = &audio_stream_info {
        if let Some(audio_path) = audio_output_path {
            let mut audio_out = avformat::output(audio_path).map_err(|e| {
                ImportError::EncoderFailed(format!("Failed to create audio output: {e}"))
            })?;

            audio_encoder = Some(Box::new(
                OpusEncoder::init(*audio_info, &mut audio_out)
                    .map_err(|e| ImportError::EncoderFailed(e.to_string()))?,
            ));
            audio_out.write_header().map_err(|e| {
                ImportError::EncoderFailed(format!("Failed to write audio header: {e}"))
            })?;
            audio_output = Some(audio_out);
        }
        Some(audio_info.sample_rate)
    } else {
        None
    };

    output
        .write_header()
        .map_err(|e| ImportError::EncoderFailed(format!("Failed to write header: {e}")))?;

    let mut video_frame = ffmpeg::frame::Video::empty();
    let mut audio_frame = ffmpeg::frame::Audio::empty();
    let mut frames_processed = 0u64;
    let mut last_progress = 0.0;

    let mut scaler: Option<ffmpeg::software::scaling::Context> = None;

    for (stream, packet) in input.packets() {
        let stream_index = stream.index();

        if stream_index == video_stream_index {
            video_decoder.send_packet(&packet)?;

            while video_decoder.receive_frame(&mut video_frame).is_ok() {
                let timestamp = video_frame.pts().unwrap_or(0);
                let time_secs = timestamp as f64 * video_time_base.numerator() as f64
                    / video_time_base.denominator().max(1) as f64;
                let duration = StdDuration::from_secs_f64(time_secs.max(0.0));

                let frame_to_encode = if video_frame.format() != ffmpeg::format::Pixel::YUV420P
                    || video_frame.width() != output_width
                    || video_frame.height() != output_height
                {
                    if scaler.is_none() {
                        scaler = Some(
                            ffmpeg::software::scaling::Context::get(
                                video_frame.format(),
                                video_frame.width(),
                                video_frame.height(),
                                ffmpeg::format::Pixel::YUV420P,
                                output_width,
                                output_height,
                                ffmpeg::software::scaling::Flags::BILINEAR,
                            )
                            .map_err(|e| {
                                ImportError::TranscodeFailed(format!(
                                    "Failed to create scaler: {e}"
                                ))
                            })?,
                        );
                    }
                    let scaler = scaler.as_mut().unwrap();

                    let mut scaled_frame = ffmpeg::frame::Video::empty();
                    scaled_frame.set_format(ffmpeg::format::Pixel::YUV420P);
                    scaled_frame.set_width(output_width);
                    scaled_frame.set_height(output_height);
                    let ret =
                        unsafe { ffmpeg::ffi::av_frame_get_buffer(scaled_frame.as_mut_ptr(), 0) };
                    if ret < 0 {
                        return Err(ImportError::TranscodeFailed(
                            "Failed to allocate frame buffer".to_string(),
                        ));
                    }

                    scaler.run(&video_frame, &mut scaled_frame)?;
                    scaled_frame.set_pts(video_frame.pts());
                    scaled_frame
                } else {
                    reference_video_frame(&video_frame)
                };

                video_encoder
                    .queue_frame(frame_to_encode, duration, &mut output)
                    .map_err(|e| ImportError::TranscodeFailed(e.to_string()))?;

                frames_processed += 1;

                let progress = (frames_processed as f64 / total_frames as f64).min(0.99);
                if progress - last_progress >= 0.01 {
                    last_progress = progress;

                    if !check_project_exists(project_path) {
                        info!("Import cancelled: project directory was deleted");
                        return Err(ImportError::TranscodeFailed("Import cancelled".to_string()));
                    }

                    emit_progress(
                        app,
                        project_path_str,
                        ImportStage::Converting,
                        progress,
                        &format!("Converting video... {}%", (progress * 100.0) as u32),
                    );
                }
            }
        } else if let Some((audio_idx, decoder, _)) = audio_decoder.as_mut()
            && stream_index == *audio_idx
            && let (Some(encoder), Some(audio_out)) =
                (audio_encoder.as_mut(), audio_output.as_mut())
        {
            decoder.send_packet(&packet)?;

            while decoder.receive_frame(&mut audio_frame).is_ok() {
                encoder.send_frame(audio_frame.clone(), audio_out);
            }
        }
    }

    video_decoder.send_eof()?;
    while video_decoder.receive_frame(&mut video_frame).is_ok() {
        let timestamp = video_frame.pts().unwrap_or(0);
        let time_secs = timestamp as f64 * video_time_base.numerator() as f64
            / video_time_base.denominator().max(1) as f64;
        let duration = StdDuration::from_secs_f64(time_secs.max(0.0));

        let frame_to_encode = if video_frame.format() != ffmpeg::format::Pixel::YUV420P
            || video_frame.width() != output_width
            || video_frame.height() != output_height
        {
            if let Some(scaler) = &mut scaler {
                let mut scaled_frame = ffmpeg::frame::Video::empty();
                scaled_frame.set_format(ffmpeg::format::Pixel::YUV420P);
                scaled_frame.set_width(output_width);
                scaled_frame.set_height(output_height);
                let ret = unsafe { ffmpeg::ffi::av_frame_get_buffer(scaled_frame.as_mut_ptr(), 0) };
                if ret < 0 {
                    return Err(ImportError::TranscodeFailed(
                        "Failed to allocate frame buffer".to_string(),
                    ));
                }
                scaler.run(&video_frame, &mut scaled_frame)?;
                scaled_frame.set_pts(video_frame.pts());
                scaled_frame
            } else {
                reference_video_frame(&video_frame)
            }
        } else {
            reference_video_frame(&video_frame)
        };

        video_encoder
            .queue_frame(frame_to_encode, duration, &mut output)
            .map_err(|e| ImportError::TranscodeFailed(e.to_string()))?;
    }

    if let Some((_, decoder, _)) = audio_decoder.as_mut() {
        decoder.send_eof()?;
        while decoder.receive_frame(&mut audio_frame).is_ok() {
            if let (Some(encoder), Some(audio_out)) =
                (audio_encoder.as_mut(), audio_output.as_mut())
            {
                encoder.send_frame(audio_frame.clone(), audio_out);
            }
        }
    }

    video_encoder
        .flush(&mut output)
        .map_err(|e| ImportError::TranscodeFailed(format!("Failed to flush video: {e}")))?;

    if let (Some(encoder), Some(audio_out)) = (&mut audio_encoder, &mut audio_output) {
        encoder
            .flush(audio_out)
            .map_err(|e| ImportError::TranscodeFailed(format!("Failed to flush audio: {e}")))?;
        audio_out.write_trailer().map_err(|e| {
            ImportError::TranscodeFailed(format!("Failed to write audio trailer: {e}"))
        })?;
    }

    output
        .write_trailer()
        .map_err(|e| ImportError::TranscodeFailed(format!("Failed to write trailer: {e}")))?;

    drop(output);

    if let Ok(file) = std::fs::File::open(output_path) {
        let _ = file.sync_all();
    }
    if let Some(audio_path) = audio_output_path
        && let Ok(file) = std::fs::File::open(audio_path)
    {
        let _ = file.sync_all();
    }

    Ok((fps, sample_rate))
}

#[tauri::command]
#[specta::specta]
pub async fn start_video_import(app: AppHandle, source_path: PathBuf) -> Result<PathBuf, String> {
    info!("Starting video import from: {:?}", source_path);

    let recordings_dir = crate::general_settings::GeneralSettingsStore::recordings_dir(&app);

    let project_name = generate_project_name(&source_path);
    let sanitized_name = sanitize_filename(&project_name);
    let project_dir_name = format!("{sanitized_name}.cap");

    let mut project_path = recordings_dir.join(&project_dir_name);
    let mut counter = 1;
    while project_path.exists() {
        let new_name = format!("{sanitized_name} ({counter}).cap");
        project_path = recordings_dir.join(new_name);
        counter += 1;
    }

    let project_path_str = project_path.to_string_lossy().to_string();

    emit_progress(
        &app,
        &project_path_str,
        ImportStage::Probing,
        0.0,
        "Analyzing video file...",
    );

    let can_decode =
        probe_video_can_decode(&source_path).map_err(|e| format!("Cannot decode video: {e}"))?;

    if !can_decode {
        emit_progress(
            &app,
            &project_path_str,
            ImportStage::Failed,
            0.0,
            "Video format not supported",
        );
        return Err("Video format not supported or file is corrupted".to_string());
    }

    std::fs::create_dir_all(&project_path).map_err(|e| e.to_string())?;

    let segment_dir = project_path
        .join("content")
        .join("segments")
        .join("segment-0");
    std::fs::create_dir_all(&segment_dir).map_err(|e| e.to_string())?;

    let output_video_path = segment_dir.join("display.mp4");
    let output_audio_path = segment_dir.join("audio.ogg");

    let initial_meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: project_path.clone(),
        pretty_name: project_name.clone(),
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments: vec![MultipleSegment {
                    display: VideoMeta {
                        path: RelativePathBuf::from("content/segments/segment-0/display.mp4"),
                        fps: 30,
                        start_time: Some(0.0),
                        device_id: None,
                    },
                    camera: None,
                    mic: None,
                    system_audio: None,
                    cursor: None,
                    keyboard: None,
                    display_notch: None,
                }],
                cursors: Cursors::default(),
                status: Some(StudioRecordingStatus::InProgress),
            },
        })),
        upload: None,
    };

    initial_meta
        .save_for_project()
        .map_err(|e| format!("Failed to save initial metadata: {e:?}"))?;

    emit_progress(
        &app,
        &project_path_str,
        ImportStage::Converting,
        0.0,
        "Starting conversion...",
    );

    let return_path = project_path.clone();

    tokio::spawn(async move {
        let app_clone = app.clone();
        let project_path_str_clone = project_path_str.clone();
        let source_path_clone = source_path.clone();
        let output_path_clone = output_video_path.clone();
        let audio_path_clone = output_audio_path.clone();
        let project_path_clone = project_path.clone();

        if !check_project_exists(&project_path) {
            info!("Import aborted before start: project directory missing");
            return;
        }

        let result = tokio::task::spawn_blocking(move || {
            transcode_video(
                &app_clone,
                &source_path_clone,
                &output_path_clone,
                Some(&audio_path_clone),
                &project_path_str_clone,
                &project_path_clone,
            )
        })
        .await;

        match result {
            Ok(Ok((fps, sample_rate))) => {
                emit_progress(
                    &app,
                    &project_path_str,
                    ImportStage::Finalizing,
                    0.95,
                    "Creating project metadata...",
                );

                let audio_file_size = std::fs::metadata(&output_audio_path)
                    .map(|m| m.len())
                    .unwrap_or(0);
                const MIN_VALID_AUDIO_SIZE: u64 = 1000;
                let system_audio =
                    if sample_rate.is_some() && audio_file_size > MIN_VALID_AUDIO_SIZE {
                        Some(AudioMeta {
                            path: RelativePathBuf::from("content/segments/segment-0/audio.ogg"),
                            start_time: Some(0.0),
                            device_id: None,
                            gap_summary: None,
                        })
                    } else {
                        None
                    };

                let meta = RecordingMeta {
                    platform: Some(Platform::default()),
                    project_path: project_path.clone(),
                    pretty_name: project_name,
                    sharing: None,
                    inner: RecordingMetaInner::Studio(Box::new(
                        StudioRecordingMeta::MultipleSegments {
                            inner: MultipleSegments {
                                segments: vec![MultipleSegment {
                                    display: VideoMeta {
                                        path: RelativePathBuf::from(
                                            "content/segments/segment-0/display.mp4",
                                        ),
                                        fps,
                                        start_time: Some(0.0),
                                        device_id: None,
                                    },
                                    camera: None,
                                    mic: None,
                                    system_audio,
                                    cursor: None,
                                    keyboard: None,
                                    display_notch: None,
                                }],
                                cursors: Cursors::default(),
                                status: Some(StudioRecordingStatus::Complete),
                            },
                        },
                    )),
                    upload: None,
                };

                if let Err(e) = meta.save_for_project() {
                    error!("Failed to save metadata: {:?}", e);
                    emit_progress(
                        &app,
                        &project_path_str,
                        ImportStage::Failed,
                        0.0,
                        &format!("Failed to save metadata: {e:?}"),
                    );
                    return;
                }

                let screenshots_dir = project_path.join("screenshots");
                if let Err(e) = std::fs::create_dir_all(&screenshots_dir) {
                    error!("Failed to create screenshots directory: {:?}", e);
                } else {
                    let display_screenshot = screenshots_dir.join("display.jpg");
                    let video_path = output_video_path.clone();
                    tokio::spawn(async move {
                        if let Err(e) =
                            create_screenshot(video_path, display_screenshot, None).await
                        {
                            error!("Failed to create thumbnail for imported video: {}", e);
                        }
                    });
                }

                emit_progress(
                    &app,
                    &project_path_str,
                    ImportStage::Complete,
                    1.0,
                    "Import complete!",
                );

                info!("Video import complete: {:?}", project_path);
            }
            Ok(Err(e)) => {
                error!("Transcoding failed: {}", e);
                emit_progress(
                    &app,
                    &project_path_str,
                    ImportStage::Failed,
                    0.0,
                    &e.to_string(),
                );
            }
            Err(e) => {
                error!("Transcoding task panicked: {}", e);
                emit_progress(
                    &app,
                    &project_path_str,
                    ImportStage::Failed,
                    0.0,
                    &format!("Transcoding task failed: {e}"),
                );
            }
        }
    });

    Ok(return_path)
}

async fn append_mp4_to_editor_project(
    app: AppHandle,
    target_project_path: PathBuf,
    source_path: PathBuf,
) -> Result<usize, String> {
    if !is_mp4_import_path(&source_path) {
        return Err("Select an MP4 video file to import".to_string());
    }

    let mut target_meta = RecordingMeta::load_for_project(&target_project_path)
        .map_err(|e| format!("Failed to load target project metadata: {e}"))?;
    let mut config = ProjectConfiguration::load(&target_project_path).unwrap_or_default();
    let existing_segments = {
        let inner = ensure_multiple_segments(&mut target_meta)?;
        inner.status = Some(StudioRecordingStatus::Complete);
        inner.segments.clone()
    };
    ensure_project_timeline(&mut config, &target_project_path, &existing_segments)?;

    let new_index = existing_segments.len() as u32;
    let (_, target_relative_dir) = unique_segment_dir(&target_project_path, new_index)
        .map_err(|e| format!("Failed to create imported segment directory: {e}"))?;

    let output_video_relative_path =
        RelativePathBuf::from(format!("{target_relative_dir}/display.mp4"));
    let output_audio_relative_path =
        RelativePathBuf::from(format!("{target_relative_dir}/audio.ogg"));
    let output_video_path = output_video_relative_path.to_path(&target_project_path);
    let output_audio_path = output_audio_relative_path.to_path(&target_project_path);
    let project_path_str = target_project_path.to_string_lossy().to_string();

    emit_progress(
        &app,
        &project_path_str,
        ImportStage::Probing,
        0.0,
        "Analyzing video file...",
    );

    let can_decode =
        probe_video_can_decode(&source_path).map_err(|e| format!("Cannot decode video: {e}"))?;
    if !can_decode {
        return Err("Video format not supported or file is corrupted".to_string());
    }

    emit_progress(
        &app,
        &project_path_str,
        ImportStage::Converting,
        0.0,
        "Starting conversion...",
    );

    let app_for_transcode = app.clone();
    let source_path_for_transcode = source_path.clone();
    let output_video_path_for_transcode = output_video_path.clone();
    let output_audio_path_for_transcode = output_audio_path.clone();
    let project_path_str_for_transcode = project_path_str.clone();
    let target_project_path_for_transcode = target_project_path.clone();

    let (fps, sample_rate) = tokio::task::spawn_blocking(move || {
        transcode_video(
            &app_for_transcode,
            &source_path_for_transcode,
            &output_video_path_for_transcode,
            Some(&output_audio_path_for_transcode),
            &project_path_str_for_transcode,
            &target_project_path_for_transcode,
        )
    })
    .await
    .map_err(|e| format!("Video import task failed: {e}"))?
    .map_err(|e| e.to_string())?;

    let duration = get_video_duration_secs(&output_video_path)?;
    let audio_file_size = std::fs::metadata(&output_audio_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    const MIN_VALID_AUDIO_SIZE: u64 = 1000;
    let system_audio = if sample_rate.is_some() && audio_file_size > MIN_VALID_AUDIO_SIZE {
        Some(AudioMeta {
            path: output_audio_relative_path,
            start_time: Some(0.0),
            device_id: None,
            gap_summary: None,
        })
    } else {
        None
    };

    let imported_segment = MultipleSegment {
        display: VideoMeta {
            path: output_video_relative_path,
            fps,
            start_time: Some(0.0),
            device_id: None,
        },
        camera: None,
        mic: None,
        system_audio,
        cursor: None,
        keyboard: None,
        display_notch: None,
    };

    {
        let inner = ensure_multiple_segments(&mut target_meta)?;
        inner.status = Some(StudioRecordingStatus::Complete);
        inner.segments.push(imported_segment.clone());
    }

    ensure_project_timeline(&mut config, &target_project_path, &existing_segments)?
        .segments
        .push(TimelineSegment {
            recording_clip: new_index,
            timescale: 1.0,
            start: 0.0,
            end: duration,
            name: None,
            speed_audio_mode: None,
            hide_cursor: None,
            volume: None,
        });
    add_clip_configs(
        &mut config,
        new_index,
        std::slice::from_ref(&imported_segment),
    );

    target_meta
        .save_for_project()
        .map_err(|e| format!("Failed to save project metadata: {e:?}"))?;
    config
        .write(&target_project_path)
        .map_err(|e| format!("Failed to save project config: {e}"))?;

    emit_progress(
        &app,
        &project_path_str,
        ImportStage::Complete,
        1.0,
        "Import complete!",
    );

    Ok(1)
}

async fn append_cap_project_to_editor_project(
    app: AppHandle,
    target_project_path: PathBuf,
    source_project_path: PathBuf,
) -> Result<usize, String> {
    let source_meta = RecordingMeta::load_for_project(&source_project_path)
        .map_err(|e| format!("Failed to load source project metadata: {e}"))?;
    match &source_meta.inner {
        RecordingMetaInner::Studio(_) => cap_editor::append_studio_cap_project_to_editor_project(
            target_project_path,
            source_project_path,
        ),
        RecordingMetaInner::Instant(InstantRecordingMeta::Complete { .. }) => {
            append_mp4_to_editor_project(app, target_project_path, source_meta.output_path()).await
        }
        RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { .. }) => {
            Err("Source Cap project is still recording".to_string())
        }
        RecordingMetaInner::Instant(InstantRecordingMeta::Failed { error }) => {
            Err(format!("Source Cap project failed: {error}"))
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn add_existing_recording_to_editor(
    window: Window,
    source_path: PathBuf,
) -> Result<u32, String> {
    let target_project_path = editor_project_path_from_window(&window)?;

    if same_project_path(&target_project_path, &source_path) {
        return Err("Cannot import a recording into itself".to_string());
    }

    let app = window.app_handle().clone();
    let imported_count = if is_mp4_import_path(&source_path) {
        append_mp4_to_editor_project(app, target_project_path, source_path).await?
    } else if is_cap_project_path(&source_path) {
        crate::wait_for_recording_ready(&app, &source_path).await?;
        append_cap_project_to_editor_project(app, target_project_path, source_path).await?
    } else {
        return Err("Select an MP4 file or a Cap project folder".to_string());
    };
    let imported_count =
        u32::try_from(imported_count).map_err(|_| "Too many recordings imported".to_string())?;

    EditorInstances::remove(window).await;

    Ok(imported_count)
}

#[tauri::command]
#[specta::specta]
pub async fn start_image_import(app: AppHandle, source_path: PathBuf) -> Result<PathBuf, String> {
    info!("Starting image import from: {:?}", source_path);

    if !source_path.is_file() {
        return Err("Image file does not exist".to_string());
    }

    let source_path_for_decode = source_path.clone();
    let (image_width, image_height, image_data) =
        tokio::task::spawn_blocking(move || -> Result<(u32, u32, Vec<u8>), String> {
            let image = image::ImageReader::open(&source_path_for_decode)
                .map_err(|e| format!("Failed to open image: {e}"))?
                .with_guessed_format()
                .map_err(|e| format!("Failed to detect image format: {e}"))?
                .decode()
                .map_err(|e| format!("Failed to decode image: {e}"))?;

            let width = image.width();
            let height = image.height();

            if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
                return Err(format!("Image dimensions exceed maximum: {width}x{height}"));
            }

            if width
                .checked_mul(height)
                .and_then(|p| p.checked_mul(4))
                .is_none()
            {
                return Err(format!("Image dimensions overflow: {width}x{height}"));
            }

            let rgba = image.to_rgba8();

            Ok((width, height, rgba.into_raw()))
        })
        .await
        .map_err(|e| format!("Failed to import image: {e}"))??;

    let screenshots_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("screenshots");
    std::fs::create_dir_all(&screenshots_dir)
        .map_err(|e| format!("Failed to create screenshots directory: {e}"))?;

    let project_name = generate_image_project_name(&source_path);
    let filename = project_name.replace(":", ".");
    let filename = format!("{}.cap", sanitize_filename::sanitize(&filename));
    let project_path = screenshots_dir.join(cap_utils::ensure_unique_filename(
        &filename,
        &screenshots_dir,
    )?);
    std::fs::create_dir_all(&project_path)
        .map_err(|e| format!("Failed to create screenshot project directory: {e}"))?;

    let image_filename = "original.png";
    let image_path = project_path.join(image_filename);
    let image_path_for_write = image_path.clone();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let file = std::fs::File::create(&image_path_for_write)
            .map_err(|e| format!("Failed to create imported image file: {e}"))?;
        let encoder = image::codecs::png::PngEncoder::new_with_quality(
            std::io::BufWriter::new(file),
            image::codecs::png::CompressionType::Default,
            image::codecs::png::FilterType::Adaptive,
        );

        ImageEncoder::write_image(
            encoder,
            &image_data,
            image_width,
            image_height,
            image::ColorType::Rgba8.into(),
        )
        .map_err(|e| format!("Failed to encode imported image: {e}"))
    })
    .await
    .map_err(|e| format!("Failed to write imported image: {e}"))??;

    let video_meta = VideoMeta {
        path: RelativePathBuf::from(image_filename),
        fps: 0,
        start_time: Some(0.0),
        device_id: None,
    };

    let segment = SingleSegment {
        display: video_meta,
        camera: None,
        audio: None,
        cursor: None,
    };

    let meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: project_path.clone(),
        pretty_name: project_name,
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::SingleSegment { segment })),
        upload: None,
    };

    meta.save_for_project()
        .map_err(|e| format!("Failed to save screenshot metadata: {e:?}"))?;

    ProjectConfiguration::default()
        .write(&project_path)
        .map_err(|e| format!("Failed to save screenshot project config: {e}"))?;

    let _ = crate::NewScreenshotAdded {
        path: image_path.clone(),
    }
    .emit(&app);

    Ok(image_path)
}

#[tauri::command]
#[specta::specta]
pub async fn check_import_ready(project_path: PathBuf) -> Result<bool, String> {
    debug!("check_import_ready called for: {:?}", project_path);

    let meta = match RecordingMeta::load_for_project(&project_path) {
        Ok(m) => m,
        Err(e) => {
            debug!("check_import_ready: meta load failed: {:?}", e);
            return Ok(false);
        }
    };

    let is_complete = match &meta.inner {
        RecordingMetaInner::Studio(studio) => {
            matches!(studio.status(), StudioRecordingStatus::Complete)
        }
        RecordingMetaInner::Instant(instant) => {
            matches!(instant, InstantRecordingMeta::Complete { .. })
        }
    };

    if !is_complete {
        debug!("check_import_ready: not complete yet");
        return Ok(false);
    }

    let video_path = project_path
        .join("content")
        .join("segments")
        .join("segment-0")
        .join("display.mp4");

    if !video_path.exists() {
        debug!(
            "check_import_ready: video path doesn't exist: {:?}",
            video_path
        );
        return Ok(false);
    }

    let can_decode = probe_video_can_decode(&video_path);
    debug!(
        "check_import_ready: probe_video_can_decode result: {:?}",
        can_decode
    );
    if !can_decode.unwrap_or(false) {
        return Ok(false);
    }

    let duration = get_media_duration(&video_path);
    debug!(
        "check_import_ready: get_media_duration result: {:?}",
        duration
    );
    if duration.is_none() {
        return Ok(false);
    }

    debug!("check_import_ready: all checks passed, returning true");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_video_frames_share_reference_counted_pixel_storage() {
        let mut source = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::YUV420P, 16, 12);
        source.set_pts(Some(417));
        source.data_mut(0)[..4].copy_from_slice(&[11, 22, 33, 44]);
        let original = source.data(0).as_ptr();

        let referenced = reference_video_frame(&source);

        assert_eq!(referenced.data(0).as_ptr(), original);
        assert_eq!(referenced.format(), ffmpeg::format::Pixel::YUV420P);
        assert_eq!((referenced.width(), referenced.height()), (16, 12));
        assert_eq!(referenced.pts(), Some(417));
        let buffer = unsafe { (*source.as_ptr()).buf[0] };
        assert!(!buffer.is_null());
        assert_eq!(unsafe { ffmpeg::ffi::av_buffer_get_ref_count(buffer) }, 2);

        drop(source);

        assert_eq!(&referenced.data(0)[..4], &[11, 22, 33, 44]);
        let retained = unsafe { (*referenced.as_ptr()).buf[0] };
        assert_eq!(unsafe { ffmpeg::ffi::av_buffer_get_ref_count(retained) }, 1);
    }

    #[test]
    fn imported_video_frame_references_preserve_non_yuv_formats() {
        let mut source = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, 12, 8);
        source.set_pts(Some(93));

        let referenced = reference_video_frame(&source);

        assert_eq!(referenced.data(0).as_ptr(), source.data(0).as_ptr());
        assert_eq!(referenced.format(), ffmpeg::format::Pixel::BGRA);
        assert_eq!((referenced.width(), referenced.height()), (12, 8));
        assert_eq!(referenced.pts(), Some(93));
    }
}
