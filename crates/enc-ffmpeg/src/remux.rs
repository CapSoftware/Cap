use std::{
    ffi::CString,
    io::Write,
    path::{Path, PathBuf},
    ptr,
    sync::atomic::{AtomicI32, Ordering},
    time::Duration,
};

use cap_media_info::{AudioInfo, AudioInfoError};
use ffmpeg::{ChannelLayout, codec as avcodec, format as avformat, packet::Mut as PacketMut};

use crate::audio::opus::{OpusEncoder, OpusEncoderError};

static ORIGINAL_LOG_LEVEL: AtomicI32 = AtomicI32::new(-1);

fn suppress_ffmpeg_logs() {
    unsafe {
        let current = ffmpeg::ffi::av_log_get_level();
        ORIGINAL_LOG_LEVEL.store(current, Ordering::SeqCst);
        ffmpeg::ffi::av_log_set_level(ffmpeg::ffi::AV_LOG_QUIET);
    }
}

fn restore_ffmpeg_logs() {
    let original = ORIGINAL_LOG_LEVEL.load(Ordering::SeqCst);
    if original >= 0 {
        unsafe {
            ffmpeg::ffi::av_log_set_level(original);
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RemuxError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("FFmpeg error: {0}")]
    Ffmpeg(#[from] ffmpeg::Error),
    #[error("No input fragments provided")]
    NoFragments,
    #[error("Fragment not found: {0}")]
    FragmentNotFound(PathBuf),
    #[error("No audio stream found")]
    NoAudioStream,
    #[error("Opus encoder error: {0}")]
    OpusEncoder(#[from] OpusEncoderError),
    #[error("Audio info error: {0}")]
    AudioInfo(#[from] AudioInfoError),
    #[error("Concat demuxer not found")]
    ConcatDemuxerNotFound,
}

pub fn concatenate_video_fragments(fragments: &[PathBuf], output: &Path) -> Result<(), RemuxError> {
    if fragments.is_empty() {
        return Err(RemuxError::NoFragments);
    }

    for fragment in fragments {
        if !fragment.exists() {
            return Err(RemuxError::FragmentNotFound(fragment.clone()));
        }
    }

    let concat_list_path = output.with_extension("concat.txt");
    {
        let mut file = std::fs::File::create(&concat_list_path)?;
        for fragment in fragments {
            writeln!(
                file,
                "file '{}'",
                fragment.to_string_lossy().replace('\'', "'\\''")
            )?;
        }
    }

    let result = concatenate_with_concat_demuxer(&concat_list_path, output);

    let _ = std::fs::remove_file(&concat_list_path);

    result
}

fn open_input_with_format(
    path: &Path,
    format_name: &str,
    options: ffmpeg::Dictionary,
) -> Result<avformat::context::Input, RemuxError> {
    unsafe {
        let format_cstr =
            CString::new(format_name).map_err(|_| RemuxError::ConcatDemuxerNotFound)?;
        let input_format = ffmpeg::ffi::av_find_input_format(format_cstr.as_ptr());
        if input_format.is_null() {
            return Err(RemuxError::ConcatDemuxerNotFound);
        }

        let path_cstr = CString::new(path.to_string_lossy().as_bytes()).map_err(|_| {
            RemuxError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Invalid path",
            ))
        })?;

        let mut ps = ptr::null_mut();
        let mut opts = options.disown();

        let ret =
            ffmpeg::ffi::avformat_open_input(&mut ps, path_cstr.as_ptr(), input_format, &mut opts);

        ffmpeg::Dictionary::own(opts);

        if ret < 0 {
            return Err(ffmpeg::Error::from(ret).into());
        }

        let ret = ffmpeg::ffi::avformat_find_stream_info(ps, ptr::null_mut());
        if ret < 0 {
            ffmpeg::ffi::avformat_close_input(&mut ps);
            return Err(ffmpeg::Error::from(ret).into());
        }

        Ok(avformat::context::Input::wrap(ps))
    }
}

fn remux_streams(
    ictx: &mut avformat::context::Input,
    octx: &mut avformat::context::Output,
) -> Result<(), RemuxError> {
    let mut stream_mapping: Vec<Option<usize>> = Vec::new();
    let mut output_stream_index = 0usize;

    for input_stream in ictx.streams() {
        let codec_params = input_stream.parameters();
        let medium = codec_params.medium();

        if medium == ffmpeg::media::Type::Video || medium == ffmpeg::media::Type::Audio {
            stream_mapping.push(Some(output_stream_index));
            output_stream_index += 1;

            let mut output_stream = octx.add_stream(None)?;
            output_stream.set_parameters(codec_params);
            unsafe {
                (*output_stream.as_mut_ptr()).time_base = (*input_stream.as_ptr()).time_base;
            }
        } else {
            stream_mapping.push(None);
        }
    }

    octx.write_header()?;

    let mut last_dts: Vec<i64> = vec![i64::MIN; output_stream_index];
    let mut dts_offset: Vec<i64> = vec![0; output_stream_index];

    for (input_stream, packet) in ictx.packets() {
        let input_stream_index = input_stream.index();

        if let Some(Some(output_index)) = stream_mapping.get(input_stream_index) {
            let output_index = *output_index;
            let mut packet = packet;
            let input_time_base = input_stream.time_base();
            let output_time_base = octx.stream(output_index).unwrap().time_base();

            packet.rescale_ts(input_time_base, output_time_base);

            let current_dts = packet.dts().unwrap_or(0);

            if last_dts[output_index] != i64::MIN && current_dts <= last_dts[output_index] {
                dts_offset[output_index] = last_dts[output_index] - current_dts + 1;
            }

            let adjusted_dts = current_dts + dts_offset[output_index];
            let adjusted_pts = packet.pts().map(|pts| pts + dts_offset[output_index]);

            unsafe {
                (*packet.as_mut_ptr()).dts = adjusted_dts;
                if let Some(pts) = adjusted_pts {
                    (*packet.as_mut_ptr()).pts = pts;
                }
            }

            last_dts[output_index] = adjusted_dts;

            packet.set_stream(output_index);
            packet.set_position(-1);

            packet.write_interleaved(octx)?;
        }
    }

    octx.write_trailer()?;

    Ok(())
}

fn concatenate_with_concat_demuxer(
    concat_list_path: &Path,
    output: &Path,
) -> Result<(), RemuxError> {
    let mut options = ffmpeg::Dictionary::new();
    options.set("safe", "0");

    let mut ictx = open_input_with_format(concat_list_path, "concat", options)?;
    let mut octx = avformat::output(output)?;

    remux_streams(&mut ictx, &mut octx)
}

pub fn concatenate_audio_to_ogg(fragments: &[PathBuf], output: &Path) -> Result<(), RemuxError> {
    if fragments.is_empty() {
        return Err(RemuxError::NoFragments);
    }

    for fragment in fragments {
        if !fragment.exists() {
            return Err(RemuxError::FragmentNotFound(fragment.clone()));
        }
    }

    let concat_list_path = output.with_extension("concat.txt");
    {
        let mut file = std::fs::File::create(&concat_list_path)?;
        for fragment in fragments {
            writeln!(
                file,
                "file '{}'",
                fragment.to_string_lossy().replace('\'', "'\\''")
            )?;
        }
    }

    let result = transcode_audio_to_ogg(&concat_list_path, output);

    let _ = std::fs::remove_file(&concat_list_path);

    result
}

fn transcode_audio_to_ogg(concat_list_path: &Path, output: &Path) -> Result<(), RemuxError> {
    let mut options = ffmpeg::Dictionary::new();
    options.set("safe", "0");

    let mut ictx = open_input_with_format(concat_list_path, "concat", options)?;

    let input_stream = ictx
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .ok_or(RemuxError::NoAudioStream)?;

    let input_stream_index = input_stream.index();
    let input_time_base = input_stream.time_base();

    let decoder_ctx = avcodec::Context::from_parameters(input_stream.parameters())?;
    let mut decoder = decoder_ctx.decoder().audio()?;

    if decoder.channel_layout().is_empty() {
        decoder.set_channel_layout(ChannelLayout::default(decoder.channels() as i32));
    }
    decoder.set_packet_time_base(input_time_base);

    let input_audio_info = AudioInfo::from_decoder(&decoder)?;

    let mut octx = avformat::output(output)?;

    let mut opus_encoder = OpusEncoder::init(input_audio_info, &mut octx)?;

    octx.write_header()?;

    let mut decoded_frame = ffmpeg::frame::Audio::empty();

    for (stream, packet) in ictx.packets() {
        if stream.index() == input_stream_index {
            decoder.send_packet(&packet)?;

            while decoder.receive_frame(&mut decoded_frame).is_ok() {
                opus_encoder.queue_frame(decoded_frame.clone(), Duration::MAX, &mut octx)?;
            }
        }
    }

    decoder.send_eof()?;

    while decoder.receive_frame(&mut decoded_frame).is_ok() {
        opus_encoder.queue_frame(decoded_frame.clone(), Duration::MAX, &mut octx)?;
    }

    opus_encoder.flush(&mut octx)?;

    octx.write_trailer()?;

    Ok(())
}

pub fn stream_copy_fragments(fragments: &[PathBuf], output: &Path) -> Result<(), RemuxError> {
    concatenate_video_fragments(fragments, output)
}

pub fn probe_media_valid(path: &Path) -> bool {
    suppress_ffmpeg_logs();
    let result = avformat::input(path).is_ok();
    restore_ffmpeg_logs();
    result
}

pub fn probe_video_can_decode(path: &Path) -> Result<bool, String> {
    suppress_ffmpeg_logs();
    let result = probe_video_can_decode_inner(path);
    restore_ffmpeg_logs();
    result
}

fn probe_video_can_decode_inner(path: &Path) -> Result<bool, String> {
    let input = avformat::input(path).map_err(|e| format!("Failed to open file: {e}"))?;

    let input_stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| "No video stream found".to_string())?;

    let decoder_ctx = avcodec::Context::from_parameters(input_stream.parameters())
        .map_err(|e| format!("Failed to create decoder context: {e}"))?;

    let mut decoder = decoder_ctx
        .decoder()
        .video()
        .map_err(|e| format!("Failed to create video decoder: {e}"))?;

    let stream_index = input_stream.index();

    let mut input = avformat::input(path).map_err(|e| format!("Failed to reopen file: {e}"))?;

    let mut frame = ffmpeg::frame::Video::empty();
    let mut packets_tried = 0;
    const MAX_PACKETS: usize = 100;

    for (stream, packet) in input.packets() {
        if stream.index() != stream_index {
            continue;
        }

        packets_tried += 1;

        if let Err(e) = decoder.send_packet(&packet) {
            if packets_tried >= MAX_PACKETS {
                return Err(format!(
                    "Failed to send packet after {packets_tried} attempts: {e}"
                ));
            }
            continue;
        }

        match decoder.receive_frame(&mut frame) {
            Ok(()) => return Ok(true),
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => continue,
            Err(ffmpeg::Error::Eof) => break,
            Err(e) => {
                if packets_tried >= MAX_PACKETS {
                    return Err(format!(
                        "Failed to decode frame after {packets_tried} packets: {e}"
                    ));
                }
                continue;
            }
        }
    }

    if let Err(e) = decoder.send_eof() {
        return Err(format!("Failed to send EOF: {e}"));
    }

    loop {
        match decoder.receive_frame(&mut frame) {
            Ok(()) => return Ok(true),
            Err(ffmpeg::Error::Eof) => break,
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => continue,
            Err(e) => return Err(format!("Failed to receive frame after EOF: {e}")),
        }
    }

    Err(format!(
        "No decodable frames found after trying {packets_tried} packets"
    ))
}

pub fn get_media_duration(path: &Path) -> Option<Duration> {
    suppress_ffmpeg_logs();
    let result = get_media_duration_inner(path);
    restore_ffmpeg_logs();
    result
}

fn get_media_duration_inner(path: &Path) -> Option<Duration> {
    let input = avformat::input(path).ok()?;
    let duration_ts = input.duration();
    if duration_ts <= 0 {
        return None;
    }
    Some(Duration::from_micros(duration_ts as u64))
}

pub fn get_video_fps(path: &Path) -> Option<u32> {
    suppress_ffmpeg_logs();
    let result = get_video_fps_inner(path);
    restore_ffmpeg_logs();
    result
}

fn get_video_fps_inner(path: &Path) -> Option<u32> {
    let input = avformat::input(path).ok()?;
    let stream = input.streams().best(ffmpeg::media::Type::Video)?;
    let rate = stream.avg_frame_rate();
    if rate.denominator() == 0 {
        return None;
    }
    Some((rate.numerator() as f64 / rate.denominator() as f64).round() as u32)
}

pub fn probe_m4s_can_decode_with_init(
    init_path: &Path,
    segment_path: &Path,
) -> Result<bool, String> {
    let temp_path = segment_path.with_extension("probe_temp.mp4");

    let init_data = std::fs::read(init_path)
        .map_err(|e| format!("Failed to read init segment {}: {e}", init_path.display()))?;
    let segment_data = std::fs::read(segment_path)
        .map_err(|e| format!("Failed to read segment {}: {e}", segment_path.display()))?;

    {
        let mut temp_file = std::fs::File::create(&temp_path)
            .map_err(|e| format!("Failed to create temp file: {e}"))?;
        temp_file
            .write_all(&init_data)
            .map_err(|e| format!("Failed to write init data: {e}"))?;
        temp_file
            .write_all(&segment_data)
            .map_err(|e| format!("Failed to write segment data: {e}"))?;
        temp_file
            .sync_all()
            .map_err(|e| format!("Failed to sync temp file: {e}"))?;
    }

    let result = probe_video_can_decode(&temp_path);

    if let Err(e) = std::fs::remove_file(&temp_path) {
        tracing::warn!("failed to remove temp file {}: {}", temp_path.display(), e);
    }

    result
}

pub fn concatenate_m4s_segments_with_init(
    init_path: &Path,
    segments: &[PathBuf],
    output: &Path,
) -> Result<(), RemuxError> {
    if segments.is_empty() {
        return Err(RemuxError::NoFragments);
    }

    if !init_path.exists() {
        return Err(RemuxError::FragmentNotFound(init_path.to_path_buf()));
    }

    for segment in segments {
        if !segment.exists() {
            return Err(RemuxError::FragmentNotFound(segment.clone()));
        }
    }

    let combined_path = output.with_extension("combined_fmp4.mp4");

    {
        let init_data = std::fs::read(init_path)?;
        let mut combined_file = std::fs::File::create(&combined_path)?;
        combined_file.write_all(&init_data)?;

        for segment in segments {
            let segment_data = std::fs::read(segment)?;
            combined_file.write_all(&segment_data)?;
        }
        combined_file.sync_all()?;
    }

    let result = remux_to_regular_mp4(&combined_path, output);

    if let Err(e) = std::fs::remove_file(&combined_path) {
        tracing::warn!(
            "failed to remove combined file {}: {}",
            combined_path.display(),
            e
        );
    }

    result
}

fn remux_to_regular_mp4(input_path: &Path, output_path: &Path) -> Result<(), RemuxError> {
    let mut ictx = avformat::input(input_path)?;
    let mut octx = avformat::output(output_path)?;

    remux_streams(&mut ictx, &mut octx)
}

pub fn remux_file(input_path: &Path, output_path: &Path) -> Result<(), RemuxError> {
    remux_to_regular_mp4(input_path, output_path)
}
