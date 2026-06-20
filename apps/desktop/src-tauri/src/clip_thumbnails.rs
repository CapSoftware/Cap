use std::{path::Path, sync::LazyLock};

use cap_project::{RecordingMetaInner, StudioRecordingMeta};
use tokio::sync::Semaphore;

use crate::editor_window::WindowEditorInstance;

const THUMB_MAX_WIDTH: u32 = 240;
const THUMB_JPEG_QUALITY: u8 = 70;
const SEEK_DECODE_PACKET_LIMIT: usize = 240;

static THUMBNAIL_SEMAPHORE: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(4));

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(editor_instance))]
pub async fn get_clip_thumbnail(
    editor_instance: WindowEditorInstance,
    recording_segment: u32,
    time: f64,
) -> Result<String, String> {
    let project_path = editor_instance.project_path.clone();
    let meta = editor_instance.meta();

    let RecordingMetaInner::Studio(studio) = &meta.inner else {
        return Err("Clip thumbnails are only available for studio recordings".to_string());
    };

    let display_path = match studio.as_ref() {
        StudioRecordingMeta::SingleSegment { segment } => meta.path(&segment.display.path),
        StudioRecordingMeta::MultipleSegments { inner } => {
            let segment = inner
                .segments
                .get(recording_segment as usize)
                .ok_or_else(|| format!("Recording segment {recording_segment} not found"))?;
            meta.path(&segment.display.path)
        }
    };

    let time = time.max(0.0);
    let cache_path = project_path.join("thumbnails").join("clips").join(format!(
        "seg{recording_segment}_{}.jpg",
        (time * 1000.0).round() as i64
    ));

    if tokio::fs::try_exists(&cache_path).await.unwrap_or(false) {
        return Ok(cache_path.to_string_lossy().into_owned());
    }

    let _permit = THUMBNAIL_SEMAPHORE
        .acquire()
        .await
        .map_err(|e| format!("Failed to acquire thumbnail permit: {e}"))?;

    if tokio::fs::try_exists(&cache_path).await.unwrap_or(false) {
        return Ok(cache_path.to_string_lossy().into_owned());
    }

    let output = cache_path.clone();
    tokio::task::spawn_blocking(move || decode_clip_thumbnail(&display_path, time, &output))
        .await
        .map_err(|e| format!("Thumbnail task failed: {e}"))??;

    Ok(cache_path.to_string_lossy().into_owned())
}

fn decode_clip_thumbnail(input: &Path, time: f64, output: &Path) -> Result<(), String> {
    use ffmpeg::rescale::{Rescale, TIME_BASE};

    let mut ictx =
        ffmpeg::format::input(input).map_err(|e| format!("Failed to open video: {e}"))?;

    let stream = ictx
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or("No video stream found")?;
    let stream_index = stream.index();

    let mut decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .map_err(|e| e.to_string())?
        .decoder()
        .video()
        .map_err(|e| e.to_string())?;

    let src_width = decoder.width();
    let src_height = decoder.height();
    if src_width == 0 || src_height == 0 {
        return Err("Invalid video dimensions".to_string());
    }

    let scale = (THUMB_MAX_WIDTH as f32 / src_width as f32).min(1.0);
    let target_width = ((src_width as f32 * scale).round() as u32).max(1);
    let target_height = ((src_height as f32 * scale).round() as u32).max(1);

    let mut scaler = ffmpeg::software::scaling::context::Context::get(
        decoder.format(),
        src_width,
        src_height,
        ffmpeg::format::Pixel::RGB24,
        target_width,
        target_height,
        ffmpeg::software::scaling::flag::Flags::BILINEAR,
    )
    .map_err(|e| e.to_string())?;

    if time > 0.0 {
        let position_us = (time * 1_000_000.0) as i64;
        let seek_target = position_us.rescale((1, 1_000_000), TIME_BASE);
        decoder.flush();
        ictx.seek(seek_target, ..seek_target)
            .map_err(|e| format!("Failed to seek to {position_us}us: {e}"))?;
    }

    let mut frame = ffmpeg::frame::Video::empty();
    let mut got_frame = false;
    let mut packets_tried = 0usize;

    'outer: for (packet_stream, packet) in ictx.packets() {
        if packet_stream.index() != stream_index {
            continue;
        }

        packets_tried += 1;

        if decoder.send_packet(&packet).is_err() {
            if packets_tried >= SEEK_DECODE_PACKET_LIMIT {
                break;
            }
            continue;
        }

        match decoder.receive_frame(&mut frame) {
            Ok(()) => {
                got_frame = true;
                break 'outer;
            }
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => {}
            Err(ffmpeg::Error::Eof) => break 'outer,
            Err(e) => {
                if packets_tried >= SEEK_DECODE_PACKET_LIMIT {
                    return Err(format!("Failed to decode frame: {e}"));
                }
            }
        }

        if packets_tried >= SEEK_DECODE_PACKET_LIMIT {
            break;
        }
    }

    if !got_frame {
        decoder
            .send_eof()
            .map_err(|e| format!("Failed to flush decoder: {e}"))?;
        loop {
            match decoder.receive_frame(&mut frame) {
                Ok(()) => {
                    got_frame = true;
                    break;
                }
                Err(ffmpeg::Error::Eof) => break,
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => continue,
                Err(e) => return Err(format!("Failed to flush decoder: {e}")),
            }
        }
    }

    if !got_frame {
        return Err("No decodable frames found".to_string());
    }

    let mut rgb_frame = ffmpeg::frame::Video::empty();
    scaler
        .run(&frame, &mut rgb_frame)
        .map_err(|e| e.to_string())?;

    let width = rgb_frame.width() as usize;
    let height = rgb_frame.height() as usize;
    let src_stride = rgb_frame.stride(0);
    let dst_stride = width * 3;
    if src_stride < dst_stride {
        return Err(format!(
            "Unexpected RGB stride: src_stride={src_stride}, expected >= {dst_stride}"
        ));
    }
    let mut img_buffer = vec![0u8; height * dst_stride];
    for y in 0..height {
        let src_slice = &rgb_frame.data(0)[y * src_stride..y * src_stride + dst_stride];
        img_buffer[y * dst_stride..(y + 1) * dst_stride].copy_from_slice(src_slice);
    }

    use image::ImageEncoder;

    let mut jpeg_bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, THUMB_JPEG_QUALITY)
        .write_image(
            &img_buffer,
            width as u32,
            height as u32,
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("Failed to encode thumbnail: {e}"))?;

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create thumbnail directory: {e}"))?;
    }

    let tmp_path = output.with_extension("jpg.tmp");
    std::fs::write(&tmp_path, &jpeg_bytes)
        .map_err(|e| format!("Failed to write thumbnail: {e}"))?;
    std::fs::rename(&tmp_path, output).map_err(|e| format!("Failed to persist thumbnail: {e}"))?;

    Ok(())
}
