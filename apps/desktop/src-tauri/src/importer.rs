use crate::windows::{CapWindowId, ShowCapWindow};
use cap_project::{
    AudioMeta, Platform, ProjectConfiguration, RecordingMeta, RecordingMetaInner, SingleSegment,
    StudioRecordingMeta, VideoMeta,
};
use cap_utils::ensure_dir;
use chrono::{DateTime, Local};
use ffmpeg::{self, format::input as ffmpeg_input};
use relative_path::RelativePathBuf;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct ImportProgress {
    pub status: String,
    pub progress: f64,
    pub message: String,
}

#[tauri::command]
#[specta::specta]
pub async fn import_video_file(app: AppHandle, video_path: String) -> Result<String, String> {
    if !Path::new(&video_path).exists() {
        return Err("Video file not found".to_string());
    }

    let id = Uuid::new_v4().to_string();
    let recordings_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("recordings");

    let project_dir = recordings_dir.join(format!("{}.cap", id));

    let allowed_exts = ["mp4", "mov", "webm", "m4v"];
    let ext = Path::new(&video_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());

    if ext
        .as_deref()
        .map(|e| !allowed_exts.contains(&e))
        .unwrap_or(true)
    {
        return Err(format!(
            "Unsupported video format. Supported formats are: {}",
            allowed_exts.join(", ")
        ));
    }

    ensure_dir(&project_dir).map_err(|e| format!("Failed to create project directory: {}", e))?;
    let content_dir = project_dir.join("content");
    ensure_dir(&content_dir).map_err(|e| format!("Failed to create content directory: {}", e))?;

    let video_output_path = content_dir.join("display.mp4");
    let audio_output_path = content_dir.join("audio-mic.m4a");

    let metadata = get_video_metadata(&video_path)?;

    convert_and_extract(&video_path, &video_output_path, &audio_output_path).await?;

    let now: DateTime<Local> = Local::now();
    let pretty_name = format!("Import {}", now.format("%Y-%m-%d at %H.%M.%S"));

    let meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: project_dir.clone(),
        pretty_name,
        sharing: None,
        inner: RecordingMetaInner::Studio(StudioRecordingMeta::SingleSegment {
            segment: SingleSegment {
                display: VideoMeta {
                    path: RelativePathBuf::from("content/display.mp4"),
                    fps: metadata.fps,
                    start_time: None,
                },
                camera: None,
                audio: if audio_output_path.exists() {
                    Some(AudioMeta {
                        path: RelativePathBuf::from("content/audio-mic.m4a"),
                        start_time: None,
                    })
                } else {
                    None
                },
                cursor: None,
            },
        }),
    };

    meta.save_for_project()
        .map_err(|e| format!("Failed to save project metadata: {:?}", e))?;

    let project_config = ProjectConfiguration::default();
    project_config
        .write(&project_dir)
        .map_err(|e| format!("Failed to write project config: {}", e))?;

    ShowCapWindow::Editor {
        project_path: project_dir.clone(),
    }
    .show(&app)
    .await
    .map_err(|e| format!("Failed to open editor: {}", e))?;

    Ok(project_dir.to_string_lossy().to_string())
}

#[derive(Debug)]
struct VideoMetadata {
    fps: u32,
    width: u32,
    height: u32,
    duration: f64,
}

fn get_video_metadata(video_path: &str) -> Result<VideoMetadata, String> {
    ffmpeg::init().map_err(|e| format!("Failed to initialise ffmpeg: {e}"))?;

    let ictx = ffmpeg_input(video_path).map_err(|e| format!("Failed to open input video: {e}"))?;

    let video_stream = ictx
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| "No video stream found".to_string())?;

    let frame_rate = video_stream.avg_frame_rate();
    let fps = if frame_rate.denominator() != 0 {
        ((frame_rate.numerator() as f64) / (frame_rate.denominator() as f64)).round() as u32
    } else {
        30
    };

    let codec_ctx = ffmpeg::codec::context::Context::from_parameters(video_stream.parameters())
        .map_err(|e| format!("Unable to read codec parameters: {e}"))?;
    let video_decoder = codec_ctx
        .decoder()
        .video()
        .map_err(|e| format!("Unable to create decoder: {e}"))?;

    let width = video_decoder.width();
    let height = video_decoder.height();

    let duration = ictx.duration() as f64 / 1_000_000.0;

    Ok(VideoMetadata {
        fps,
        width,
        height,
        duration,
    })
}

async fn convert_and_extract(
    input_path: &str,
    video_output_path: &PathBuf,
    audio_output_path: &PathBuf,
) -> Result<(), String> {
    let input_path = input_path.to_owned();
    let video_output_path = video_output_path.clone();
    let audio_output_path = audio_output_path.clone();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        ffmpeg::init().map_err(|e| format!("Failed to initialise ffmpeg: {e}"))?;

        if video_output_path.exists() {
            std::fs::remove_file(&video_output_path).ok();
        }

        let input_ext = Path::new(&input_path)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("");

        if input_ext.eq_ignore_ascii_case("mp4") {
            std::fs::copy(&input_path, &video_output_path)
                .map_err(|e| format!("Failed to copy video file: {e}"))?;
        } else {
            match remux_to_mp4(&input_path, &video_output_path) {
                Ok(()) => {
                    println!("Successfully remuxed video to MP4");
                }
                Err(e) => {
                    println!("Remux failed: {}, falling back to transcoding", e);
                    transcode_to_mp4(&input_path, &video_output_path)?;
                }
            }
        }

        if audio_output_path.exists() {
            std::fs::remove_file(&audio_output_path).ok();
        }

        if let Err(e) = extract_audio(&input_path, &audio_output_path) {
            eprintln!("Audio extraction failed: {} — continuing without audio", e);
            let _ = std::fs::remove_file(&audio_output_path);
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {e}"))??;

    Ok(())
}

fn remux_to_mp4(input: &str, output_path: &Path) -> Result<(), String> {
    use std::collections::HashMap;

    let mut ictx = ffmpeg_input(input).map_err(|e| format!("Failed to open input: {e}"))?;
    let mut octx =
        ffmpeg::format::output(output_path).map_err(|e| format!("Failed to create output: {e}"))?;

    let mut stream_mapping: HashMap<usize, usize> = HashMap::new();
    let mut last_dts: HashMap<usize, Option<i64>> = HashMap::new();

    for (stream_index, istream) in ictx.streams().enumerate() {
        match istream.parameters().medium() {
            ffmpeg::media::Type::Video | ffmpeg::media::Type::Audio => {
                let codec_id = istream.parameters().id();

                let needs_transcode = match istream.parameters().medium() {
                    ffmpeg::media::Type::Video => {
                        matches!(
                            codec_id,
                            ffmpeg::codec::Id::VP8
                                | ffmpeg::codec::Id::VP9
                                | ffmpeg::codec::Id::AV1
                                | ffmpeg::codec::Id::THEORA
                        )
                    }
                    ffmpeg::media::Type::Audio => {
                        matches!(
                            codec_id,
                            ffmpeg::codec::Id::VORBIS
                                | ffmpeg::codec::Id::OPUS
                                | ffmpeg::codec::Id::FLAC
                        )
                    }
                    _ => false,
                };

                if needs_transcode {
                    return Err(format!(
                        "Input uses codec {:?} which requires transcoding. Please use a compatible format or convert first.",
                        codec_id
                    ));
                }

                let encoder = ffmpeg::codec::encoder::find(codec_id)
                    .ok_or_else(|| format!("No encoder found for codec id {:?}", codec_id))?;

                let out_index = {
                    let mut ostream = octx
                        .add_stream(encoder)
                        .map_err(|e| format!("Unable to add stream: {e}"))?;

                    ostream.set_parameters(istream.parameters());

                    ostream.index()
                };

                stream_mapping.insert(stream_index, out_index);
                last_dts.insert(out_index, None);
            }
            _ => {}
        }
    }

    octx.set_metadata(ictx.metadata().to_owned());
    octx.write_header()
        .map_err(|e| format!("Failed to write header: {e}"))?;

    for (istream, mut packet) in ictx.packets() {
        if let Some(&out_index) = stream_mapping.get(&istream.index()) {
            let in_tb = istream.time_base();
            let out_tb = {
                let out_stream = octx.stream(out_index).unwrap();
                out_stream.time_base()
            };

            packet.set_stream(out_index);
            packet.rescale_ts(in_tb, out_tb);

            if let Some(dts) = packet.dts() {
                if let Some(last) = last_dts.get(&out_index).and_then(|&d| d) {
                    if dts <= last {
                        packet.set_dts(Some(last + 1));
                    }
                }
                last_dts.insert(out_index, packet.dts());
            }

            packet
                .write_interleaved(&mut octx)
                .map_err(|e| format!("Error writing packet: {e}"))?;
        }
    }

    octx.write_trailer()
        .map_err(|e| format!("Failed to write trailer: {e}"))?;
    Ok(())
}

fn transcode_to_mp4(input: &str, output_path: &Path) -> Result<(), String> {
    use ffmpeg::{codec, format, frame, media};

    let mut ictx = ffmpeg_input(input).map_err(|e| format!("Failed to open input: {e}"))?;
    let input_stream = ictx
        .streams()
        .best(media::Type::Video)
        .ok_or_else(|| "No video stream found".to_string())?;
    let video_stream_index = input_stream.index();

    let mut decoder = codec::context::Context::from_parameters(input_stream.parameters())
        .map_err(|e| format!("Failed to create decoder context: {e}"))?
        .decoder()
        .video()
        .map_err(|e| format!("Failed to open video decoder: {e}"))?;

    let h264 = codec::encoder::find(codec::Id::H264)
        .ok_or_else(|| "H264 encoder not found in FFmpeg build".to_string())?;
    let mut enc_ctx = codec::Context::new_with_codec(h264);
    let mut encoder = enc_ctx.encoder().video().map_err(|e| e.to_string())?;

    encoder.set_width(decoder.width());
    encoder.set_height(decoder.height());
    encoder.set_format(decoder.format());

    let frame_rate = input_stream.avg_frame_rate();
    encoder.set_frame_rate(Some(frame_rate));
    encoder.set_time_base(input_stream.time_base());

    let pixels = decoder.width() as u64 * decoder.height() as u64;
    let fps = if frame_rate.denominator() != 0 {
        (frame_rate.numerator() as f64 / frame_rate.denominator() as f64)
    } else {
        30.0
    };
    let base_bitrate = 4_000_000;
    let bitrate = (base_bitrate as f64 * (pixels as f64 / (1920.0 * 1080.0)) * (fps / 30.0)) as i64;
    encoder.set_bit_rate(bitrate.max(1_000_000) as usize);

    let mut encoder = encoder.open().map_err(|e| format!("Encoder open: {e}"))?;

    let mut octx =
        format::output(output_path).map_err(|e| format!("Failed to create output: {e}"))?;

    let mut audio_stream_mapping = std::collections::HashMap::new();
    for (i, stream) in ictx.streams().enumerate() {
        if stream.parameters().medium() == media::Type::Audio {
            let codec_id = stream.parameters().id();

            if codec_id != codec::Id::AAC {
                continue;
            }

            if let Some(enc) = codec::encoder::find(codec_id) {
                let out_index = {
                    let mut ostream = octx
                        .add_stream(enc)
                        .map_err(|e| format!("Unable to add audio stream: {e}"))?;

                    ostream.set_parameters(stream.parameters());
                    ostream.index()
                };

                audio_stream_mapping.insert(i, out_index);
            }
        }
    }

    let video_out_index = {
        let mut ostream = octx
            .add_stream(h264)
            .map_err(|e| format!("Unable to add video stream: {e}"))?;

        ostream.set_parameters(&encoder);
        ostream.index()
    };

    octx.set_metadata(ictx.metadata().to_owned());
    octx.write_header()
        .map_err(|e| format!("Failed to write header: {e}"))?;

    let mut decoded = frame::Video::empty();
    let mut encoded = ffmpeg::Packet::empty();

    for (stream, packet) in ictx.packets() {
        if stream.index() == video_stream_index {
            decoder.send_packet(&packet).map_err(|e| e.to_string())?;
            while decoder.receive_frame(&mut decoded).is_ok() {
                encoder.send_frame(&decoded).map_err(|e| e.to_string())?;
                while encoder.receive_packet(&mut encoded).is_ok() {
                    encoded.set_stream(video_out_index);
                    encoded.rescale_ts(
                        encoder.time_base(),
                        octx.stream(video_out_index).unwrap().time_base(),
                    );
                    encoded
                        .write_interleaved(&mut octx)
                        .map_err(|e| format!("Error writing video packet: {e}"))?;
                }
            }
        } else if let Some(&out_index) = audio_stream_mapping.get(&stream.index()) {
            let mut packet = packet.clone();
            packet.set_stream(out_index);
            packet.rescale_ts(
                stream.time_base(),
                octx.stream(out_index).unwrap().time_base(),
            );
            packet
                .write_interleaved(&mut octx)
                .map_err(|e| format!("Error writing audio packet: {e}"))?;
        }
    }

    encoder.send_eof().ok();
    while encoder.receive_packet(&mut encoded).is_ok() {
        encoded.set_stream(video_out_index);
        encoded.rescale_ts(
            encoder.time_base(),
            octx.stream(video_out_index).unwrap().time_base(),
        );
        encoded
            .write_interleaved(&mut octx)
            .map_err(|e| format!("Error writing video packet: {e}"))?;
    }

    octx.write_trailer()
        .map_err(|e| format!("Failed to write trailer: {e}"))?;

    Ok(())
}

fn extract_audio(input: &str, output_path: &Path) -> Result<(), String> {
    use ffmpeg::{codec, media};

    let mut ictx = ffmpeg_input(input).map_err(|e| format!("Failed to open input: {e}"))?;
    let audio_stream = ictx
        .streams()
        .best(media::Type::Audio)
        .ok_or_else(|| "No audio stream found".to_string())?;

    let codec_id = audio_stream.parameters().id();

    if codec_id == codec::Id::AAC {
        let stream_index = audio_stream.index();
        remux_single_audio_stream(&mut ictx, stream_index, output_path)
    } else {
        Err(format!(
            "Unsupported audio codec {:?}. Only AAC is currently supported for import.",
            codec_id
        ))
    }
}

fn remux_single_audio_stream(
    ictx: &mut ffmpeg::format::context::Input,
    audio_stream_index: usize,
    output_path: &Path,
) -> Result<(), String> {
    use ffmpeg::format;

    if output_path.exists() {
        std::fs::remove_file(output_path).ok();
    }

    let mut octx =
        format::output(output_path).map_err(|e| format!("Failed to create output: {e}"))?;

    let audio_stream = ictx
        .stream(audio_stream_index)
        .ok_or_else(|| "Invalid audio stream index".to_string())?;

    let encoder = ffmpeg::codec::encoder::find(audio_stream.parameters().id())
        .ok_or_else(|| "No encoder for codec".to_string())?;

    let out_index = {
        let mut ostream = octx
            .add_stream(encoder)
            .map_err(|e| format!("Unable to add stream: {e}"))?;

        ostream.set_parameters(audio_stream.parameters());
        ostream.index()
    };

    octx.write_header()
        .map_err(|e| format!("Failed to write header: {e}"))?;

    let in_tb = audio_stream.time_base();
    let out_tb = octx.stream(out_index).unwrap().time_base();

    for (istream, mut packet) in ictx.packets() {
        if istream.index() != audio_stream_index {
            continue;
        }

        packet.set_stream(out_index);
        packet.rescale_ts(in_tb, out_tb);
        packet
            .write_interleaved(&mut octx)
            .map_err(|e| format!("Error writing packet: {e}"))?;
    }

    octx.write_trailer()
        .map_err(|e| format!("Failed to write trailer: {e}"))?;

    Ok(())
}
