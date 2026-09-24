use std::path::Path;

const THUMB_MAX_WIDTH: u32 = 240;
const THUMB_JPEG_QUALITY: u8 = 70;
pub(crate) const SEEK_DECODE_PACKET_LIMIT: usize = 4096;
pub(crate) const SEEK_DECODE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

pub(crate) fn decode_clip_thumbnail(input: &Path, time: f64, output: &Path) -> Result<(), String> {
    decode_clip_thumbnail_with_budget(
        input,
        time,
        output,
        SEEK_DECODE_PACKET_LIMIT,
        SEEK_DECODE_TIMEOUT,
    )
}

pub(crate) fn decode_clip_thumbnail_with_budget(
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

pub(crate) fn thumbnail_frame_reaches_target(
    frame: &ffmpeg::frame::Video,
    target_timestamp: i64,
) -> bool {
    frame
        .timestamp()
        .or_else(|| frame.pts())
        .is_none_or(|timestamp| timestamp >= target_timestamp)
}

pub(crate) fn persist_clip_thumbnail(output: &Path, jpeg_bytes: &[u8]) -> Result<(), String> {
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
