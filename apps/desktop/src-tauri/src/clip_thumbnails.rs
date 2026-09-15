use std::{path::Path, sync::LazyLock};

use cap_project::{RecordingMetaInner, StudioRecordingMeta};
use tokio::sync::Semaphore;

use crate::editor_window::WindowEditorInstance;

const THUMB_MAX_WIDTH: u32 = 240;
const THUMB_JPEG_QUALITY: u8 = 70;
const SEEK_DECODE_PACKET_LIMIT: usize = 4096;
const SEEK_DECODE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

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
    let cache_path = project_path
        .join("thumbnails")
        .join("clips-v2")
        .join(format!(
            "seg{recording_segment}_{}.jpg",
            (time * 1000.0).round() as i64
        ));

    if tokio::fs::try_exists(&cache_path).await.unwrap_or(false) {
        return Ok(cache_path.to_string_lossy().into_owned());
    }

    let permit = THUMBNAIL_SEMAPHORE
        .acquire()
        .await
        .map_err(|e| format!("Failed to acquire thumbnail permit: {e}"))?;

    if tokio::fs::try_exists(&cache_path).await.unwrap_or(false) {
        return Ok(cache_path.to_string_lossy().into_owned());
    }

    let output = cache_path.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        decode_clip_thumbnail(&display_path, time, &output)
    })
    .await
    .map_err(|e| format!("Thumbnail task failed: {e}"))??;

    Ok(cache_path.to_string_lossy().into_owned())
}

fn decode_clip_thumbnail(input: &Path, time: f64, output: &Path) -> Result<(), String> {
    decode_clip_thumbnail_with_budget(
        input,
        time,
        output,
        SEEK_DECODE_PACKET_LIMIT,
        SEEK_DECODE_TIMEOUT,
    )
}

fn decode_clip_thumbnail_with_budget(
    input: &Path,
    time: f64,
    output: &Path,
    packet_limit: usize,
    timeout: std::time::Duration,
) -> Result<(), String> {
    use ffmpeg::rescale::{Rescale, TIME_BASE};

    let mut ictx =
        ffmpeg::format::input(input).map_err(|e| format!("Failed to open video: {e}"))?;

    let stream = ictx
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or("No video stream found")?;
    let stream_index = stream.index();
    let stream_time_base = stream.time_base();
    let stream_start = match stream.start_time() {
        ffmpeg::ffi::AV_NOPTS_VALUE => 0,
        timestamp => timestamp,
    };
    let target_timestamp = ((time * 1_000_000.0) as i64)
        .rescale((1, 1_000_000), stream_time_base)
        .saturating_add(stream_start);

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
        let seek_target = target_timestamp.rescale(stream_time_base, TIME_BASE);
        decoder.flush();
        ictx.seek(seek_target, ..seek_target)
            .map_err(|e| format!("Failed to seek to {position_us}us: {e}"))?;
    }

    let mut frame = ffmpeg::frame::Video::empty();
    let mut decoded = ffmpeg::frame::Video::empty();
    let mut got_frame = false;
    let mut reached_target = false;
    let mut decoder_finished = false;
    let mut packets_tried = 0usize;
    let decode_started = std::time::Instant::now();

    'outer: for (packet_stream, packet) in ictx.packets() {
        if decode_started.elapsed() >= timeout {
            return Err("Thumbnail decode time budget exhausted".to_string());
        }
        if packet_stream.index() != stream_index {
            continue;
        }

        packets_tried += 1;

        if decoder.send_packet(&packet).is_err() {
            if packets_tried >= packet_limit {
                return Err("Thumbnail decode packet budget exhausted".to_string());
            }
            continue;
        }

        loop {
            if decode_started.elapsed() >= timeout {
                return Err("Thumbnail decode time budget exhausted".to_string());
            }
            match decoder.receive_frame(&mut decoded) {
                Ok(()) => {
                    std::mem::swap(&mut frame, &mut decoded);
                    got_frame = true;
                    if thumbnail_frame_reaches_target(&frame, target_timestamp) {
                        reached_target = true;
                        break 'outer;
                    }
                }
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => break,
                Err(ffmpeg::Error::Eof) => {
                    decoder_finished = true;
                    break 'outer;
                }
                Err(e) => {
                    if packets_tried >= packet_limit {
                        return Err(format!("Failed to decode frame: {e}"));
                    }
                    break;
                }
            }
        }

        if packets_tried >= packet_limit {
            return Err("Thumbnail decode packet budget exhausted".to_string());
        }
    }

    if !reached_target && !decoder_finished {
        decoder
            .send_eof()
            .map_err(|e| format!("Failed to flush decoder: {e}"))?;
        loop {
            if decode_started.elapsed() >= timeout {
                return Err("Thumbnail decode time budget exhausted".to_string());
            }
            match decoder.receive_frame(&mut decoded) {
                Ok(()) => {
                    std::mem::swap(&mut frame, &mut decoded);
                    got_frame = true;
                    if thumbnail_frame_reaches_target(&frame, target_timestamp) {
                        break;
                    }
                }
                Err(ffmpeg::Error::Eof) => break,
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => break,
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

    persist_clip_thumbnail(output, &jpeg_bytes)
}

fn thumbnail_frame_reaches_target(frame: &ffmpeg::frame::Video, target_timestamp: i64) -> bool {
    frame
        .timestamp()
        .or_else(|| frame.pts())
        .is_none_or(|timestamp| timestamp >= target_timestamp)
}

fn persist_clip_thumbnail(output: &Path, jpeg_bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create thumbnail directory: {e}"))?;

    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Failed to stage thumbnail: {e}"))?;
    staged
        .write_all(jpeg_bytes)
        .map_err(|e| format!("Failed to write thumbnail: {e}"))?;
    staged
        .persist(output)
        .map_err(|e| format!("Failed to persist thumbnail: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn concurrent_identical_thumbnails_are_all_persisted() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("clips").join("segment.jpg");
        let barrier = Arc::new(Barrier::new(4));
        let pixels = [35; 24 * 24 * 3];
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
            .encode(&pixels, 24, 24, image::ExtendedColorType::Rgb8)
            .unwrap();

        std::thread::scope(|scope| {
            let tasks = (0..4)
                .map(|_| {
                    let output = &output;
                    let jpeg = &jpeg;
                    let barrier = barrier.clone();
                    scope.spawn(move || {
                        barrier.wait();
                        persist_clip_thumbnail(output, jpeg)
                    })
                })
                .collect::<Vec<_>>();

            for task in tasks {
                task.join().unwrap().unwrap();
            }
        });

        assert_eq!(std::fs::read(&output).unwrap(), jpeg);
        assert_eq!(image::open(&output).unwrap().width(), 24);
        assert_eq!(
            std::fs::read_dir(output.parent().unwrap()).unwrap().count(),
            1
        );
    }

    #[test]
    fn replacing_cached_thumbnail_preserves_contents() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("segment.jpg");
        persist_clip_thumbnail(&output, b"old thumbnail").unwrap();
        persist_clip_thumbnail(&output, b"replacement thumbnail").unwrap();
        assert_eq!(std::fs::read(&output).unwrap(), b"replacement thumbnail");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }
}

#[cfg(test)]
mod decoding_tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::{Arc, Barrier},
    };

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        fixture_from_bytes(include_bytes!("../test-data/clip-thumbnail-gop.mp4"))
    }

    fn fixture_from_bytes(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        ffmpeg::init().unwrap();
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("gop.mp4");
        std::fs::write(&input, bytes).unwrap();
        (root, input)
    }

    #[test]
    fn split_thumbnails_use_requested_time_inside_keyframe_interval() {
        let (root, input) = fixture();
        for (time, expected_channel) in [(0.0, 0), (1.5, 1), (2.5, 2), (3.0, 2)] {
            let output = root.path().join(format!("{time}.jpg"));
            decode_clip_thumbnail(&input, time, &output).unwrap();
            let image = image::open(&output).unwrap().to_rgb8();
            let pixel = image.get_pixel(80, 45).0;
            assert!(
                pixel[expected_channel] > 100,
                "requested {time}s, got {pixel:?}"
            );
            for (channel, value) in pixel.iter().enumerate() {
                if channel != expected_channel {
                    assert!(*value < 20, "requested {time}s, got {pixel:?}");
                }
            }
        }
    }

    #[test]
    fn simultaneous_decodes_of_one_clip_all_produce_valid_thumbnail() {
        let (root, input) = fixture();
        let output = root.path().join("same-clip.jpg");
        let barrier = Arc::new(Barrier::new(4));

        std::thread::scope(|scope| {
            let tasks = (0..4)
                .map(|_| {
                    let input = &input;
                    let output = &output;
                    let barrier = barrier.clone();
                    scope.spawn(move || {
                        barrier.wait();
                        decode_clip_thumbnail(input, 1.5, output)
                    })
                })
                .collect::<Vec<_>>();
            for task in tasks {
                task.join().unwrap().unwrap();
            }
        });

        let image = image::open(output).unwrap().to_rgb8();
        let pixel = image.get_pixel(80, 45).0;
        assert!(pixel[1] > 100 && pixel[0] < 20 && pixel[2] < 20);
    }

    #[test]
    fn long_gop_thumbnails_reach_requested_time_and_preserve_eof_fallback() {
        let (root, input) =
            fixture_from_bytes(include_bytes!("../test-data/clip-thumbnail-long-gop.mp4"));
        for time in [8.5, 10.0, 11.0] {
            let output = root.path().join(format!("{time}.jpg"));
            decode_clip_thumbnail(&input, time, &output).unwrap();
            let pixel = image::open(&output).unwrap().to_rgb8().get_pixel(80, 45).0;
            assert!(
                pixel[2] > 100 && pixel[1] < 20 && pixel[0] < 20,
                "requested {time}s, got {pixel:?}"
            );
        }
    }

    #[test]
    fn exhausted_decode_budget_does_not_write_partial_thumbnail() {
        let (root, input) =
            fixture_from_bytes(include_bytes!("../test-data/clip-thumbnail-long-gop.mp4"));
        let output = root.path().join("thumbnail.jpg");
        for (packet_limit, timeout, expected_error) in [
            (240, std::time::Duration::from_secs(2), "packet budget"),
            (
                SEEK_DECODE_PACKET_LIMIT,
                std::time::Duration::ZERO,
                "time budget",
            ),
        ] {
            let result =
                decode_clip_thumbnail_with_budget(&input, 8.5, &output, packet_limit, timeout);
            assert!(result.unwrap_err().contains(expected_error));
            assert!(!output.exists());
        }
    }

    #[test]
    fn frames_without_timestamps_preserve_first_frame_fallback() {
        let mut frame = ffmpeg::frame::Video::empty();
        assert!(thumbnail_frame_reaches_target(&frame, 100));
        frame.set_pts(Some(99));
        assert!(!thumbnail_frame_reaches_target(&frame, 100));
        frame.set_pts(Some(100));
        assert!(thumbnail_frame_reaches_target(&frame, 100));
    }
}
