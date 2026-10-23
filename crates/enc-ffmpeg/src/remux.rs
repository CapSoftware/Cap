use std::{
    ffi::CString,
    io::Write,
    path::{Path, PathBuf},
    ptr,
    sync::atomic::{AtomicI32, AtomicU64, Ordering},
    time::Duration,
};

use cap_media_info::{AudioInfo, AudioInfoError};
use ffmpeg::{ChannelLayout, codec as avcodec, format as avformat, packet::Mut as PacketMut};

use crate::audio::opus::{OpusEncoder, OpusEncoderError};

static ORIGINAL_LOG_LEVEL: AtomicI32 = AtomicI32::new(-1);
static VALIDATED_AGGREGATE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const SEEK_PROBE_PACKET_LIMIT: usize = 240;
const MAX_SEEK_PROBE_WORKERS: usize = 8;
const SEEK_PROBE_PADDING_US: i64 = 250_000;

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
    #[error("Fragment path cannot be written to an FFmpeg concat list: {0}")]
    InvalidConcatPath(PathBuf),
    #[error("No audio stream found")]
    NoAudioStream,
    #[error("Opus encoder error: {0}")]
    OpusEncoder(#[from] OpusEncoderError),
    #[error("Audio info error: {0}")]
    AudioInfo(#[from] AudioInfoError),
    #[error("Concat demuxer not found")]
    ConcatDemuxerNotFound,
    #[error("Video validation failed: {0}")]
    VideoValidation(&'static str),
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
    write_concat_list(fragments, &concat_list_path)?;

    let result = concatenate_with_concat_demuxer(&concat_list_path, output);

    let _ = std::fs::remove_file(&concat_list_path);

    result
}

/// Joins files cut from one recording timeline, such as the output of each
/// muxer process when one was replaced mid-recording. Each file keeps its own
/// start time, so video after a gap stays at its capture time instead of
/// closing the gap; the last frame before a gap is held across it.
pub fn concatenate_video_fragments_on_timeline(
    fragments: &[PathBuf],
    output: &Path,
) -> Result<(), RemuxError> {
    if fragments.is_empty() {
        return Err(RemuxError::NoFragments);
    }

    for fragment in fragments {
        if !fragment.exists() {
            return Err(RemuxError::FragmentNotFound(fragment.clone()));
        }
    }

    let spans = fragments
        .iter()
        .map(|fragment| media_span(fragment))
        .collect::<Result<Vec<_>, _>>()?;
    let concat_list_path = output.with_extension("concat.txt");
    let entries = fragments
        .iter()
        .enumerate()
        .map(|(index, fragment)| {
            let entry = concat_fragment_entry(fragment, &concat_list_path)?;
            Ok(match timeline_duration(&spans, index) {
                Some(duration) => format!("{entry}duration {duration}us\n"),
                None => entry,
            })
        })
        .collect::<Result<Vec<_>, RemuxError>>()?;
    std::fs::write(&concat_list_path, entries.concat())?;

    let result = concatenate_with_concat_demuxer(&concat_list_path, output);

    let _ = std::fs::remove_file(&concat_list_path);

    result
}

#[derive(Clone, Copy, Debug)]
struct MediaSpan {
    start: i64,
    duration: i64,
}

fn media_span(path: &Path) -> Result<Option<MediaSpan>, RemuxError> {
    let input = ffmpeg::format::input(path)?;
    let (start, duration) = (container_start_time(&input), input.duration());
    Ok((start != ffmpeg::ffi::AV_NOPTS_VALUE && duration > 0)
        .then_some(MediaSpan { start, duration }))
}

fn container_start_time(input: &avformat::context::Input) -> i64 {
    unsafe { (*input.as_ptr()).start_time }
}

/// How far into the joined timeline the file after `index` starts, in
/// microseconds: the gap between the two start times, but never less than the
/// file's own duration, so overlapping files still play end to end. `None`
/// leaves the concat demuxer to use the file's probed duration.
fn timeline_duration(spans: &[Option<MediaSpan>], index: usize) -> Option<i64> {
    let current = spans.get(index).copied().flatten()?;
    let next = spans.get(index + 1).copied().flatten()?;
    Some((next.start - current.start).max(current.duration))
}

fn concat_fragment_entry(fragment: &Path, concat_list: &Path) -> Result<String, RemuxError> {
    let fragment = std::path::absolute(fragment)?;
    let concat_list = std::path::absolute(concat_list)?;
    let directory = concat_list.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Concat list has no parent directory",
        )
    })?;
    let relative = fragment.strip_prefix(directory).ok();
    let reference = relative.unwrap_or(&fragment);
    let text = reference
        .to_str()
        .filter(|text| !text.contains(['\r', '\n']))
        .ok_or_else(|| RemuxError::InvalidConcatPath(fragment.clone()))?;
    let prefix = if relative.is_some() { "./" } else { "" };

    Ok(format!("file '{prefix}{}'\n", text.replace('\'', "'\\''")))
}

fn write_concat_list(fragments: &[PathBuf], concat_list: &Path) -> Result<(), RemuxError> {
    let entries = fragments
        .iter()
        .map(|fragment| concat_fragment_entry(fragment, concat_list))
        .collect::<Result<Vec<_>, _>>()?;
    std::fs::write(concat_list, entries.concat())?;
    Ok(())
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

        let path_text = path.to_str().ok_or_else(|| {
            RemuxError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "FFmpeg input path is not valid UTF-8",
            ))
        })?;
        let path_cstr = CString::new(path_text).map_err(|_| {
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

struct StreamRemuxer {
    stream_mapping: Vec<Option<usize>>,
    last_dts: Vec<i64>,
    dts_offset: Vec<i64>,
}

impl StreamRemuxer {
    fn new(
        ictx: &avformat::context::Input,
        octx: &mut avformat::context::Output,
    ) -> Result<Self, RemuxError> {
        let mut stream_mapping = Vec::new();
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

        Ok(Self {
            stream_mapping,
            last_dts: vec![i64::MIN; output_stream_index],
            dts_offset: vec![0; output_stream_index],
        })
    }

    fn write_packet(
        &mut self,
        mut packet: ffmpeg::Packet,
        input_time_base: ffmpeg::Rational,
        octx: &mut avformat::context::Output,
    ) -> Result<(), RemuxError> {
        if let Some(Some(output_index)) = self.stream_mapping.get(packet.stream()) {
            let output_index = *output_index;
            let output_time_base = octx.stream(output_index).unwrap().time_base();

            packet.rescale_ts(input_time_base, output_time_base);

            let current_dts = packet.dts().unwrap_or(0);

            if self.last_dts[output_index] != i64::MIN && current_dts <= self.last_dts[output_index]
            {
                self.dts_offset[output_index] = self.last_dts[output_index] - current_dts + 1;
            }

            let adjusted_dts = current_dts + self.dts_offset[output_index];
            let adjusted_pts = packet.pts().map(|pts| pts + self.dts_offset[output_index]);

            unsafe {
                (*packet.as_mut_ptr()).dts = adjusted_dts;
                if let Some(pts) = adjusted_pts {
                    (*packet.as_mut_ptr()).pts = pts;
                }
            }

            self.last_dts[output_index] = adjusted_dts;

            packet.set_stream(output_index);
            packet.set_position(-1);

            packet.write_interleaved(octx)?;
        }
        Ok(())
    }
}

fn remux_streams(
    ictx: &mut avformat::context::Input,
    octx: &mut avformat::context::Output,
) -> Result<(), RemuxError> {
    let mut remuxer = StreamRemuxer::new(ictx, octx)?;
    for (input_stream, packet) in ictx.packets() {
        remuxer.write_packet(packet, input_stream.time_base(), octx)?;
    }

    octx.write_trailer()?;

    Ok(())
}

fn remux_streams_validated_with_reader(
    ictx: &mut avformat::context::Input,
    octx: &mut avformat::context::Output,
    mut read_packet: impl FnMut(
        &mut ffmpeg::Packet,
        &mut avformat::context::Input,
    ) -> Result<(), ffmpeg::Error>,
) -> Result<(), RemuxError> {
    let stream = ictx
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or(RemuxError::VideoValidation("No video stream found"))?;
    let video_index = stream.index();
    let context = avcodec::Context::from_parameters(stream.parameters())?;
    let codec = ffmpeg::decoder::find(context.id())
        .ok_or(RemuxError::VideoValidation("Video decoder unavailable"))?;
    let mut decoder = context.decoder();
    decoder.check(avcodec::decoder::Check::EXPLODE | avcodec::decoder::Check::CRC);
    let mut decoder = decoder.open_as(codec)?;
    let mut frame = unsafe { ffmpeg::Frame::empty() };
    let mut decoded = false;
    let mut remuxer = StreamRemuxer::new(ictx, octx)?;

    loop {
        let mut packet = ffmpeg::Packet::empty();
        match read_packet(&mut packet, ictx) {
            Ok(()) => {}
            Err(ffmpeg::Error::Eof) => break,
            Err(error) => return Err(error.into()),
        }
        if packet.stream() == video_index {
            if packet.is_corrupt() {
                return Err(RemuxError::VideoValidation("Corrupt video packet"));
            }
            if !decoded {
                decoder.send_packet(&packet)?;
                loop {
                    match decoder.receive_frame(&mut frame) {
                        Ok(()) if !frame.is_corrupt() => decoded = true,
                        Ok(()) => {
                            return Err(RemuxError::VideoValidation("Corrupt decoded video frame"));
                        }
                        Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => {
                            break;
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
            }
        }
        let input_time_base = ictx
            .stream(packet.stream())
            .ok_or(ffmpeg::Error::StreamNotFound)?
            .time_base();
        remuxer.write_packet(packet, input_time_base, octx)?;
    }

    decoder.send_eof()?;
    loop {
        match decoder.receive_frame(&mut frame) {
            Ok(()) if !frame.is_corrupt() => decoded = true,
            Ok(()) => {
                return Err(RemuxError::VideoValidation("Corrupt decoded video frame"));
            }
            Err(ffmpeg::Error::Eof) => break,
            Err(error) => return Err(error.into()),
        }
    }
    if !decoded {
        return Err(RemuxError::VideoValidation(
            "Video contains no decoded frames",
        ));
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
    write_concat_list(fragments, &concat_list_path)?;

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

pub fn probe_video_seek_points(path: &Path, sample_count: usize) -> Result<(), String> {
    suppress_ffmpeg_logs();
    let result = probe_video_seek_points_inner(path, sample_count);
    restore_ffmpeg_logs();
    result
}

fn probe_video_can_decode_inner(path: &Path) -> Result<bool, String> {
    let mut input = avformat::input(path).map_err(|e| format!("Failed to open file: {e}"))?;

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

fn probe_video_seek_points_inner(path: &Path, sample_count: usize) -> Result<(), String> {
    let duration_us = avformat::input(path)
        .map_err(|e| format!("Failed to open file: {e}"))?
        .duration();
    let probe_points = build_seek_probe_positions(duration_us, sample_count);
    let workers = seek_probe_worker_count(probe_points.len());
    if workers <= 1 {
        return probe_video_seek_point_batch(path, &probe_points);
    }

    // Each probe decodes a full-resolution keyframe on one core; independent
    // demuxer and decoder instances let them overlap without changing what is
    // validated or which error is reported first.
    run_in_ordered_workers(&probe_points, workers, |&position_us| {
        probe_video_seek_point_batch(path, &[position_us])
    })
    .into_iter()
    .collect()
}

fn run_in_ordered_workers<T: Sync, R: Send>(
    items: &[T],
    workers: usize,
    run: impl Fn(&T) -> Result<R, String> + Sync,
) -> Vec<Result<R, String>> {
    let workers = workers.clamp(1, items.len().max(1));
    let run = &run;
    let mut ordered = std::thread::scope(|scope| {
        let handles = (0..workers)
            .map(|worker| {
                scope.spawn(move || {
                    items
                        .iter()
                        .enumerate()
                        .skip(worker)
                        .step_by(workers)
                        .map(|(index, item)| (index, run(item)))
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>();
        let mut ordered = (0..items.len()).map(|_| None).collect::<Vec<_>>();
        for (worker, handle) in handles.into_iter().enumerate() {
            match handle.join() {
                Ok(results) => {
                    for (index, result) in results {
                        ordered[index] = Some(result);
                    }
                }
                Err(_) => {
                    for index in (worker..items.len()).step_by(workers) {
                        ordered[index] = Some(Err("Seek probe worker panicked".to_string()));
                    }
                }
            }
        }
        ordered
    });
    ordered
        .iter_mut()
        .map(|result| {
            result
                .take()
                .unwrap_or_else(|| Err("Seek probe result missing".to_string()))
        })
        .collect()
}

fn seek_probe_worker_count(probes: usize) -> usize {
    let cores = std::thread::available_parallelism().map_or(1, usize::from);
    probes.min(cores / 2).clamp(1, MAX_SEEK_PROBE_WORKERS)
}

fn probe_video_seek_point_batch(path: &Path, probe_points: &[i64]) -> Result<(), String> {
    let mut input = avformat::input(path).map_err(|e| format!("Failed to open file: {e}"))?;

    let (stream_index, decoder_ctx) = {
        let input_stream = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or_else(|| "No video stream found".to_string())?;

        let stream_index = input_stream.index();
        let decoder_ctx = avcodec::Context::from_parameters(input_stream.parameters())
            .map_err(|e| format!("Failed to create decoder context: {e}"))?;

        (stream_index, decoder_ctx)
    };

    let mut decoder = decoder_ctx
        .decoder()
        .video()
        .map_err(|e| format!("Failed to create video decoder: {e}"))?;

    let mut frame = ffmpeg::frame::Video::empty();

    for &position_us in probe_points {
        probe_video_seek_point_with(
            &mut input,
            &mut decoder,
            stream_index,
            position_us,
            &mut frame,
        )?;
    }

    Ok(())
}

fn probe_video_seek_point_with(
    input: &mut avformat::context::Input,
    decoder: &mut ffmpeg::decoder::Video,
    stream_index: usize,
    position_us: i64,
    frame: &mut ffmpeg::frame::Video,
) -> Result<(), String> {
    use ffmpeg::rescale;

    let seek_target = rescale::Rescale::rescale(&position_us, (1, 1_000_000), rescale::TIME_BASE);
    decoder.flush();
    input
        .seek(seek_target, ..seek_target)
        .map_err(|e| format!("Failed to seek to {position_us}us: {e}"))?;

    let mut packets_tried = 0usize;

    for (stream, packet) in input.packets() {
        if stream.index() != stream_index {
            continue;
        }

        packets_tried += 1;

        if let Err(e) = decoder.send_packet(&packet) {
            if packets_tried >= SEEK_PROBE_PACKET_LIMIT {
                return Err(format!(
                    "Failed to send packet after seeking to {position_us}us: {e}"
                ));
            }
            continue;
        }

        match decoder.receive_frame(frame) {
            Ok(()) => return Ok(()),
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => {}
            Err(ffmpeg::Error::Eof) => {}
            Err(e) => {
                if packets_tried >= SEEK_PROBE_PACKET_LIMIT {
                    return Err(format!(
                        "Failed to decode after seeking to {position_us}us: {e}"
                    ));
                }
            }
        }

        if packets_tried >= SEEK_PROBE_PACKET_LIMIT {
            return Err(format!(
                "No decodable frames found within {SEEK_PROBE_PACKET_LIMIT} packets after seeking to {position_us}us"
            ));
        }
    }

    decoder
        .send_eof()
        .map_err(|e| format!("Failed to send EOF after seeking to {position_us}us: {e}"))?;

    loop {
        match decoder.receive_frame(frame) {
            Ok(()) => return Ok(()),
            Err(ffmpeg::Error::Eof) => break,
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => continue,
            Err(e) => {
                return Err(format!(
                    "Failed to receive frame after EOF at {position_us}us: {e}"
                ));
            }
        }
    }

    Err(format!(
        "No decodable frames found after seeking to {position_us}us"
    ))
}

fn build_seek_probe_positions(duration_us: i64, sample_count: usize) -> Vec<i64> {
    if duration_us <= 0 {
        return vec![0];
    }

    let baseline_ratios = [0.0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9];
    let requested = sample_count.max(3).min(baseline_ratios.len() + 1);

    let mut indices = vec![0usize];
    if requested > 2 {
        let interior = requested - 2;
        let max_index = baseline_ratios.len() - 1;

        for step in 1..=interior {
            let index = ((step * max_index) + interior / 2) / interior;
            if !indices.contains(&index) {
                indices.push(index);
            }
        }
    }

    indices.sort_unstable();
    indices.dedup();

    let mut positions: Vec<i64> = indices
        .into_iter()
        .map(|index| ((duration_us as f64) * baseline_ratios[index]).round() as i64)
        .collect();

    positions.push((duration_us - SEEK_PROBE_PADDING_US).max(0));
    positions.sort_unstable();
    positions.dedup();
    positions
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

/// The stream's base frame rate (`r_frame_rate`): the rate every timestamp of
/// a variable-rate track sits on, unlike `get_video_fps`'s average, which a
/// mostly static screen recording pulls far below its capture rate.
pub fn get_video_base_fps(path: &Path) -> Option<u32> {
    suppress_ffmpeg_logs();
    let result = (|| {
        let input = avformat::input(path).ok()?;
        let stream = input.streams().best(ffmpeg::media::Type::Video)?;
        let rate = stream.rate();
        if rate.numerator() <= 0 || rate.denominator() <= 0 {
            return None;
        }
        let fps = (rate.numerator() as f64 / rate.denominator() as f64).round() as u32;
        (1..=240).contains(&fps).then_some(fps)
    })();
    restore_ffmpeg_logs();
    result
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

/// How closely a video track's packet timestamps follow a fixed ladder of
/// `1/nominal_fps` steps. Recordings stamped by the pre-fix pipeline (snap
/// ladder + full-frame monotonic bump) advance exactly one nominal tick per
/// frame, so every delta conforms; genuinely capture-timed tracks jitter and
/// gap. Note a healthy vsync-locked track can also conform — conformance
/// alone does not prove a stretch, it only rules one out.
pub struct LadderProbe {
    pub deltas: usize,
    pub conforming: usize,
}

impl LadderProbe {
    /// True when there is enough evidence and essentially every step matches
    /// the nominal cadence. The slack absorbs pause/resume resyncs, which
    /// leave a handful of oversized steps in an otherwise perfect ladder.
    pub fn is_ladder(&self) -> bool {
        const MIN_DELTAS: usize = 30;
        const MIN_CONFORMANCE: f64 = 0.98;
        self.deltas >= MIN_DELTAS && self.conforming as f64 / self.deltas as f64 >= MIN_CONFORMANCE
    }
}

pub fn probe_video_pts_ladder(path: &Path, nominal_fps: u32) -> Option<LadderProbe> {
    suppress_ffmpeg_logs();
    let result = probe_video_pts_ladder_inner(path, nominal_fps);
    restore_ffmpeg_logs();
    result
}

fn probe_video_pts_ladder_inner(path: &Path, nominal_fps: u32) -> Option<LadderProbe> {
    // 60s at 60fps; enough to judge a track without reading huge files whole.
    const MAX_DELTAS: usize = 3600;

    if nominal_fps == 0 {
        return None;
    }

    let mut ictx = avformat::input(path).ok()?;
    let (stream_index, expected_ticks) = {
        let stream = ictx.streams().best(ffmpeg::media::Type::Video)?;
        let tb = stream.time_base();
        if tb.numerator() <= 0 || tb.denominator() <= 0 {
            return None;
        }
        let ticks =
            (tb.denominator() as f64 / (tb.numerator() as f64 * nominal_fps as f64)).round() as i64;
        if ticks < 1 {
            return None;
        }
        (stream.index(), ticks)
    };

    let mut probe = LadderProbe {
        deltas: 0,
        conforming: 0,
    };
    let mut prev_ts: Option<i64> = None;

    for (stream, packet) in ictx.packets() {
        if stream.index() != stream_index {
            continue;
        }
        let Some(ts) = packet.dts().or(packet.pts()) else {
            continue;
        };
        if let Some(prev) = prev_ts {
            let delta = ts - prev;
            if delta > 0 {
                probe.deltas += 1;
                if (delta - expected_ticks).abs() <= 1 {
                    probe.conforming += 1;
                }
            }
        }
        prev_ts = Some(ts);
        if probe.deltas >= MAX_DELTAS {
            break;
        }
    }

    Some(probe)
}

/// The rate a variable-rate video track was captured at, from the first
/// `MAX_PACKETS` packet timestamps. A static screen only lengthens some
/// gaps, so the average rate understates the capture rate, and
/// `r_frame_rate` is the finest grid every timestamp lies on, which can be
/// the display's refresh rate rather than the capture rate.
pub fn get_video_capture_fps(path: &Path) -> Option<u32> {
    suppress_ffmpeg_logs();
    let result = get_video_capture_fps_inner(path);
    restore_ffmpeg_logs();
    result
}

fn get_video_capture_fps_inner(path: &Path) -> Option<u32> {
    const MAX_PACKETS: usize = 20_000;

    let mut ictx = avformat::input(path).ok()?;
    let (stream_index, time_base) = {
        let stream = ictx.streams().best(ffmpeg::media::Type::Video)?;
        let tb = stream.time_base();
        if tb.numerator() <= 0 || tb.denominator() <= 0 {
            return None;
        }
        (
            stream.index(),
            f64::from(tb.numerator()) / f64::from(tb.denominator()),
        )
    };
    let mut timestamps = Vec::new();
    for (stream, packet) in ictx.packets() {
        if stream.index() != stream_index {
            continue;
        }
        if let Some(pts) = packet.pts().or(packet.dts()) {
            timestamps.push(pts as f64 * time_base);
        }
        if timestamps.len() >= MAX_PACKETS {
            break;
        }
    }
    capture_fps_from_timestamps(timestamps)
}

/// The shortest gap between frames that recurs in runs, in 5% bins, refined
/// by the median of the gaps within 20% of it. Frames land one capture
/// interval apart whenever the screen changes, whatever the holds between
/// them, and content that changes at a lower rate for most of a recording
/// still has its faster stretches captured at the full rate. A late frame
/// leaves one short gap between two slightly longer ones, so only gaps in
/// runs, or between holds, count. Arrival jitter leaves the median a frame or
/// two per second off, so a rate within 5% of a standard capture rate is
/// that rate.
pub fn capture_fps_from_timestamps(mut timestamps: Vec<f64>) -> Option<u32> {
    const MIN_GAPS: usize = 10;
    const BIN_RATIO: f64 = 1.05;
    const CLUSTER_TOLERANCE: f64 = 0.2;
    const STANDARD_RATES: [f64; 14] = [
        24.0, 25.0, 30.0, 48.0, 50.0, 60.0, 72.0, 75.0, 90.0, 100.0, 120.0, 144.0, 165.0, 240.0,
    ];
    const SNAP_TOLERANCE: f64 = 0.05;
    const HOLD_RATIO: f64 = 3.0;
    const HOLD_SECS: f64 = 0.1;

    timestamps.sort_by(f64::total_cmp);
    let gaps: Vec<f64> = timestamps
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .filter(|gap| *gap > 1e-4)
        .collect();
    if gaps.len() < MIN_GAPS {
        return None;
    }
    let within = |center: f64| {
        gaps.iter()
            .map(|gap| (gap / center - 1.0).abs() <= CLUSTER_TOLERANCE)
            .collect::<Vec<_>>()
    };
    // A gap counts beside another of its length (a run of frames) or between
    // two holds (a change captured as a pair): gaps of at least HOLD_SECS and
    // HOLD_RATIO times its length. A late frame's short gap always has one
    // neighbour one capture interval long, under HOLD_SECS at 10 fps and up.
    let in_runs = |within: &[bool]| {
        let held = |i: usize, j: Option<usize>| {
            j.and_then(|j| gaps.get(j))
                .is_some_and(|gap| *gap >= HOLD_SECS && *gap >= gaps[i] * HOLD_RATIO)
        };
        (0..within.len())
            .filter(|&i| {
                within[i]
                    && ((i > 0 && within[i - 1])
                        || within.get(i + 1).copied().unwrap_or(false)
                        || (held(i, i.checked_sub(1)) && held(i, Some(i + 1))))
            })
            .count()
    };
    let bins: std::collections::BTreeSet<i64> = gaps
        .iter()
        .map(|gap| (gap.ln() / BIN_RATIO.ln()).round() as i64)
        .collect();
    // A bin is narrower than the jitter, so the first one with support can
    // sit to one side of the interval: recentre on the cluster's median.
    let mut interval = bins
        .into_iter()
        .map(|bin| BIN_RATIO.powi(bin as i32))
        .find(|center| in_runs(&within(*center)) >= MIN_GAPS)?;
    for _ in 0..3 {
        let mut cluster: Vec<f64> = gaps
            .iter()
            .copied()
            .filter(|gap| (gap / interval - 1.0).abs() <= CLUSTER_TOLERANCE)
            .collect();
        if cluster.len() < MIN_GAPS {
            return None;
        }
        cluster.sort_by(f64::total_cmp);
        interval = cluster[cluster.len() / 2];
    }
    let measured = 1.0 / interval;
    let fps = STANDARD_RATES
        .into_iter()
        .filter(|rate| (measured / rate - 1.0).abs() <= SNAP_TOLERANCE)
        .min_by(|a, b| (measured - a).abs().total_cmp(&(measured - b).abs()))
        .unwrap_or(measured.round());
    (1.0..=240.0).contains(&fps).then_some(fps as u32)
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

pub fn concatenate_m4s_segments_with_init_validated(
    init_path: &Path,
    segments: &[PathBuf],
    output: &Path,
) -> Result<(), RemuxError> {
    concatenate_m4s_segments_with_init_validated_with_reader(
        init_path,
        segments,
        output,
        ffmpeg::Packet::read,
    )
}

fn concatenate_m4s_segments_with_init_validated_with_reader(
    init_path: &Path,
    segments: &[PathBuf],
    output: &Path,
    read_packet: impl FnMut(
        &mut ffmpeg::Packet,
        &mut avformat::context::Input,
    ) -> Result<(), ffmpeg::Error>,
) -> Result<(), RemuxError> {
    if segments.is_empty() {
        return Err(RemuxError::NoFragments);
    }
    for path in std::iter::once(init_path).chain(segments.iter().map(PathBuf::as_path)) {
        if !path.exists() {
            return Err(RemuxError::FragmentNotFound(path.to_path_buf()));
        }
    }

    // Existing destinations can alias an input, which must be copied before opening the output.
    if !output.try_exists()? {
        return crate::segmented_input::with_input(
            std::iter::once(init_path).chain(segments.iter().map(PathBuf::as_path)),
            |input| {
                let mut output = avformat::output(output)?;
                remux_streams_validated_with_reader(input, &mut output, read_packet)
            },
        );
    }

    let sequence = VALIDATED_AGGREGATE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let combined_path = output.with_extension(format!(
        "validated-combined-{}-{sequence}.mp4",
        std::process::id()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut combined_file = options.open(&combined_path)?;
    let result = (|| {
        for path in std::iter::once(init_path).chain(segments.iter().map(PathBuf::as_path)) {
            let mut source = std::fs::File::open(path)?;
            std::io::copy(&mut source, &mut combined_file)?;
        }
        drop(combined_file);

        let mut ictx = avformat::input(&combined_path)?;
        let mut octx = avformat::output(output)?;
        remux_streams_validated_with_reader(&mut ictx, &mut octx, read_packet)
    })();
    if let Err(cleanup_error) = std::fs::remove_file(&combined_path) {
        tracing::warn!(
            "failed to remove validated combined file {}: {}",
            combined_path.display(),
            cleanup_error
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

/// Stream-copies the video track of `input_path` to `output_path` with every
/// timestamp multiplied by `scale`. Used to repair recordings whose video
/// track was stamped at the wrong rate (e.g. a 60fps camera recorded as
/// 30fps, leaving the track twice as long as the wall-clock recording).
/// Audio/data streams are not carried over — callers use this on video-only
/// tracks.
pub fn rescale_video_timestamps(
    input_path: &Path,
    output_path: &Path,
    scale: f64,
) -> Result<(), RemuxError> {
    suppress_ffmpeg_logs();
    let result = rescale_video_timestamps_inner(input_path, output_path, scale);
    restore_ffmpeg_logs();
    result
}

fn rescale_video_timestamps_inner(
    input_path: &Path,
    output_path: &Path,
    scale: f64,
) -> Result<(), RemuxError> {
    // Fine-grained output timescale so the scaled timestamps lose at most
    // ~11us to rounding regardless of the input's track timescale.
    const OUTPUT_TIMESCALE: i32 = 90_000;

    let mut ictx = avformat::input(input_path)?;
    let mut octx = avformat::output(output_path)?;

    let mut stream_mapping: Vec<Option<usize>> = Vec::new();
    let mut output_stream_index = 0usize;

    for input_stream in ictx.streams() {
        let codec_params = input_stream.parameters();

        if codec_params.medium() == ffmpeg::media::Type::Video {
            stream_mapping.push(Some(output_stream_index));
            output_stream_index += 1;

            let mut output_stream = octx.add_stream(None)?;
            output_stream.set_parameters(codec_params);
            unsafe {
                (*output_stream.as_mut_ptr()).time_base =
                    ffmpeg::Rational::new(1, OUTPUT_TIMESCALE).into();
            }
        } else {
            stream_mapping.push(None);
        }
    }

    octx.write_header()?;

    let mut last_dts: Vec<i64> = vec![i64::MIN; output_stream_index];

    for (input_stream, packet) in ictx.packets() {
        let input_stream_index = input_stream.index();

        if let Some(Some(output_index)) = stream_mapping.get(input_stream_index) {
            let output_index = *output_index;
            let mut packet = packet;
            let input_time_base = input_stream.time_base();
            let output_time_base = octx.stream(output_index).unwrap().time_base();

            let tick_scale = scale * f64::from(input_time_base) / f64::from(output_time_base);
            let rescale = |ts: i64| (ts as f64 * tick_scale).round() as i64;

            let scaled_pts = packet.pts().map(rescale);
            let mut scaled_dts = rescale(packet.dts().unwrap_or(0));

            if last_dts[output_index] != i64::MIN && scaled_dts <= last_dts[output_index] {
                scaled_dts = last_dts[output_index] + 1;
            }
            last_dts[output_index] = scaled_dts;

            let scaled_duration = (packet.duration() as f64 * tick_scale).round() as i64;

            unsafe {
                (*packet.as_mut_ptr()).dts = scaled_dts;
                (*packet.as_mut_ptr()).pts = scaled_pts.unwrap_or(scaled_dts).max(scaled_dts);
                (*packet.as_mut_ptr()).duration = scaled_duration.max(0);
            }

            packet.set_stream(output_index);
            packet.set_position(-1);

            packet.write_interleaved(&mut octx)?;
        }
    }

    octx.write_trailer()?;

    Ok(())
}

pub fn merge_video_audio(
    video_path: &Path,
    audio_path: &Path,
    output_path: &Path,
) -> Result<(), RemuxError> {
    suppress_ffmpeg_logs();
    let result = merge_video_audio_inner(video_path, audio_path, output_path);
    restore_ffmpeg_logs();
    result
}

fn merge_video_audio_inner(
    video_path: &Path,
    audio_path: &Path,
    output_path: &Path,
) -> Result<(), RemuxError> {
    let mut video_ctx = avformat::input(video_path)?;
    let mut audio_ctx = avformat::input(audio_path)?;
    let mut octx = avformat::output(output_path)?;

    let mut video_stream_map: Vec<Option<usize>> = Vec::new();
    let mut audio_stream_map: Vec<Option<usize>> = Vec::new();
    let mut out_idx = 0usize;

    for stream in video_ctx.streams() {
        if stream.parameters().medium() == ffmpeg::media::Type::Video {
            video_stream_map.push(Some(out_idx));
            out_idx += 1;
            let mut out_stream = octx.add_stream(None)?;
            out_stream.set_parameters(stream.parameters());
            unsafe {
                (*out_stream.as_mut_ptr()).time_base = (*stream.as_ptr()).time_base;
            }
        } else {
            video_stream_map.push(None);
        }
    }

    for stream in audio_ctx.streams() {
        if stream.parameters().medium() == ffmpeg::media::Type::Audio {
            audio_stream_map.push(Some(out_idx));
            out_idx += 1;
            let mut out_stream = octx.add_stream(None)?;
            out_stream.set_parameters(stream.parameters());
            unsafe {
                (*out_stream.as_mut_ptr()).time_base = (*stream.as_ptr()).time_base;
            }
        } else {
            audio_stream_map.push(None);
        }
    }

    octx.write_header()?;

    let mut last_dts: Vec<i64> = vec![i64::MIN; out_idx];

    for (stream, packet) in video_ctx.packets() {
        if let Some(Some(oidx)) = video_stream_map.get(stream.index()) {
            let oidx = *oidx;
            let mut packet = packet;
            packet.rescale_ts(stream.time_base(), octx.stream(oidx).unwrap().time_base());

            let dts = packet.dts().unwrap_or(0);
            if last_dts[oidx] != i64::MIN && dts <= last_dts[oidx] {
                let fixed = last_dts[oidx] + 1;
                unsafe {
                    (*packet.as_mut_ptr()).dts = fixed;
                    if let Some(pts) = packet.pts()
                        && pts <= fixed
                    {
                        (*packet.as_mut_ptr()).pts = fixed;
                    }
                }
            }
            last_dts[oidx] = packet.dts().unwrap_or(0);

            packet.set_stream(oidx);
            packet.set_position(-1);
            packet.write_interleaved(&mut octx)?;
        }
    }

    for (stream, packet) in audio_ctx.packets() {
        if let Some(Some(oidx)) = audio_stream_map.get(stream.index()) {
            let oidx = *oidx;
            let mut packet = packet;
            packet.rescale_ts(stream.time_base(), octx.stream(oidx).unwrap().time_base());

            let dts = packet.dts().unwrap_or(0);
            if last_dts[oidx] != i64::MIN && dts <= last_dts[oidx] {
                let fixed = last_dts[oidx] + 1;
                unsafe {
                    (*packet.as_mut_ptr()).dts = fixed;
                    if let Some(pts) = packet.pts()
                        && pts <= fixed
                    {
                        (*packet.as_mut_ptr()).pts = fixed;
                    }
                }
            }
            last_dts[oidx] = packet.dts().unwrap_or(0);

            packet.set_stream(oidx);
            packet.set_position(-1);
            packet.write_interleaved(&mut octx)?;
        }
    }

    octx.write_trailer()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        build_seek_probe_positions, capture_fps_from_timestamps, concat_fragment_entry,
        concatenate_audio_to_ogg, concatenate_m4s_segments_with_init,
        concatenate_m4s_segments_with_init_validated,
        concatenate_m4s_segments_with_init_validated_with_reader, concatenate_video_fragments,
        concatenate_video_fragments_on_timeline, get_video_capture_fps, get_video_fps,
        probe_video_pts_ladder, write_concat_list,
    };
    use std::{
        path::{Path, PathBuf},
        time::Duration,
    };

    fn encode_test_segments(directory: &Path) -> (PathBuf, Vec<PathBuf>) {
        use crate::segmented_stream::{SegmentedVideoEncoder, SegmentedVideoEncoderConfig};

        ffmpeg::init().unwrap();
        let mut encoder = SegmentedVideoEncoder::init(
            directory.to_path_buf(),
            cap_media_info::VideoInfo {
                pixel_format: cap_media_info::Pixel::NV12,
                width: 320,
                height: 240,
                time_base: ffmpeg::Rational(1, 1_000_000),
                frame_rate: ffmpeg::Rational(30, 1),
            },
            SegmentedVideoEncoderConfig::default(),
        )
        .unwrap();
        for index in 0..320 {
            let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, 320, 240);
            frame.data_mut(0).fill(32 + (index % 192) as u8);
            frame.data_mut(1).fill(128);
            encoder
                .queue_frame(frame, Duration::from_micros(index * 1_000_000 / 30))
                .unwrap();
        }
        encoder.finish().unwrap();
        let segments: Vec<_> = encoder
            .completed_segments()
            .iter()
            .map(|segment| segment.path.clone())
            .collect();
        assert!(segments.len() >= 2);
        (encoder.init_segment_path(), segments)
    }

    #[derive(Debug, PartialEq)]
    struct TestVideoPacket {
        pts: Option<i64>,
        dts: Option<i64>,
        duration: i64,
        data: Vec<u8>,
    }

    fn video_packet_contents(path: &Path) -> (ffmpeg::Rational, Vec<TestVideoPacket>) {
        let mut input = ffmpeg::format::input(path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        let index = stream.index();
        let time_base = stream.time_base();
        let mut packets = Vec::new();
        loop {
            let mut packet = ffmpeg::Packet::empty();
            match packet.read(&mut input) {
                Ok(()) => {}
                Err(ffmpeg::Error::Eof) => break,
                Err(error) => panic!("Failed to read video packet: {error}"),
            }
            if packet.stream() == index {
                packets.push(TestVideoPacket {
                    pts: packet.pts(),
                    dts: packet.dts(),
                    duration: packet.duration(),
                    data: packet.data().unwrap().to_vec(),
                });
            }
        }
        (time_base, packets)
    }

    fn decoded_video_frame_count(path: &Path) -> usize {
        let mut input = ffmpeg::format::input(path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        let index = stream.index();
        let mut decoder = ffmpeg::codec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .video()
            .unwrap();
        let mut frame = ffmpeg::frame::Video::empty();
        let mut count = 0;
        for (stream, packet) in input.packets() {
            if stream.index() != index {
                continue;
            }
            decoder.send_packet(&packet).unwrap();
            loop {
                match decoder.receive_frame(&mut frame) {
                    Ok(()) => {
                        assert!(!frame.is_corrupt());
                        count += 1;
                    }
                    Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => {
                        break;
                    }
                    Err(error) => panic!("Failed to decode video frame: {error}"),
                }
            }
        }
        decoder.send_eof().unwrap();
        loop {
            match decoder.receive_frame(&mut frame) {
                Ok(()) => {
                    assert!(!frame.is_corrupt());
                    count += 1;
                }
                Err(ffmpeg::Error::Eof) => break,
                Err(error) => panic!("Failed to drain video decoder: {error}"),
            }
        }
        count
    }

    fn assert_no_validated_aggregate(directory: &Path) {
        for entry in std::fs::read_dir(directory).unwrap() {
            assert!(
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".validated-combined-")
            );
        }
    }

    #[test]
    fn validated_m4s_concat_preserves_packets_timestamps_and_all_frames() {
        let directory = tempfile::tempdir().unwrap();
        let (init, segments) = encode_test_segments(&directory.path().join("source"));
        let output = directory.path().join("validated.mp4");
        let legacy = directory.path().join("legacy.mp4");
        concatenate_m4s_segments_with_init(&init, &segments, &legacy).unwrap();
        concatenate_m4s_segments_with_init_validated(&init, &segments, &output).unwrap();

        assert_eq!(
            video_packet_contents(&output),
            video_packet_contents(&legacy)
        );
        assert_eq!(decoded_video_frame_count(&output), 320);
        assert!(super::probe_video_can_decode(&output).unwrap());
        super::probe_video_seek_points(&output, 8).unwrap();
        assert_no_validated_aggregate(directory.path());
    }

    #[test]
    fn validated_m4s_concat_preserves_existing_destination_and_input_alias_support() {
        for aliases_input in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let (init, segments) = encode_test_segments(&directory.path().join("source"));
            let reference = directory.path().join("reference.mp4");
            concatenate_m4s_segments_with_init(&init, &segments, &reference).unwrap();
            let output = directory.path().join("existing.mp4");
            if aliases_input {
                std::fs::hard_link(&segments[0], &output).unwrap();
            } else {
                std::fs::write(&output, b"previous output").unwrap();
            }
            concatenate_m4s_segments_with_init_validated(&init, &segments, &output).unwrap();
            assert_eq!(
                video_packet_contents(&output),
                video_packet_contents(&reference)
            );
            assert_eq!(decoded_video_frame_count(&output), 320);
            assert_no_validated_aggregate(directory.path());
        }
    }

    #[test]
    fn validated_m4s_concat_rejects_undecodable_payload_and_retains_sources() {
        let directory = tempfile::tempdir().unwrap();
        let (init, segments) = encode_test_segments(&directory.path().join("source"));
        let init_bytes = std::fs::read(&init).unwrap();
        let mut damaged_segments = Vec::new();
        for segment in &segments {
            let mut bytes = std::fs::read(segment).unwrap();
            let mut position = 0;
            let mut payloads = 0;
            while position < bytes.len() {
                let size =
                    u32::from_be_bytes(bytes[position..position + 4].try_into().unwrap()) as usize;
                assert!(size >= 8 && size <= bytes.len() - position);
                if &bytes[position + 4..position + 8] == b"mdat" {
                    bytes[position + 8..position + size].fill(0);
                    payloads += 1;
                }
                position += size;
            }
            assert!(payloads > 0);
            std::fs::write(segment, &bytes).unwrap();
            damaged_segments.push(bytes);
        }
        let output = directory.path().join("invalid.mp4");
        assert!(concatenate_m4s_segments_with_init_validated(&init, &segments, &output).is_err());
        assert_eq!(std::fs::read(&init).unwrap(), init_bytes);
        for (segment, expected) in segments.iter().zip(damaged_segments) {
            assert_eq!(std::fs::read(segment).unwrap(), expected);
        }
        assert_no_validated_aggregate(directory.path());
    }

    #[test]
    fn validated_m4s_concat_rejects_late_packet_read_errors() {
        let directory = tempfile::tempdir().unwrap();
        let (init, segments) = encode_test_segments(&directory.path().join("source"));
        let output = directory.path().join("read-error.mp4");
        let mut packets_read = 0;
        let result = concatenate_m4s_segments_with_init_validated_with_reader(
            &init,
            &segments,
            &output,
            |packet, input| match packet.read(input) {
                Ok(()) => {
                    packets_read += 1;
                    Ok(())
                }
                Err(ffmpeg::Error::Eof) => Err(ffmpeg::Error::InvalidData),
                Err(error) => Err(error),
            },
        );
        assert_eq!(packets_read, 320);
        assert!(matches!(
            result,
            Err(super::RemuxError::Ffmpeg(ffmpeg::Error::InvalidData))
        ));
        assert_no_validated_aggregate(directory.path());
    }

    #[test]
    fn validated_m4s_concat_rejects_corrupt_packets_after_valid_frames() {
        let directory = tempfile::tempdir().unwrap();
        let (init, segments) = encode_test_segments(&directory.path().join("source"));
        let output = directory.path().join("corrupt-packet.mp4");
        let mut packets_read = 0;
        let result = concatenate_m4s_segments_with_init_validated_with_reader(
            &init,
            &segments,
            &output,
            |packet, input| {
                packet.read(input)?;
                packets_read += 1;
                if packets_read == 160 {
                    packet.set_flags(packet.flags() | ffmpeg::packet::Flags::CORRUPT);
                }
                Ok(())
            },
        );
        assert_eq!(packets_read, 160);
        assert!(matches!(
            result,
            Err(super::RemuxError::VideoValidation("Corrupt video packet"))
        ));
        assert_no_validated_aggregate(directory.path());
    }

    #[test]
    fn concat_entries_resolve_fragments_from_the_list_directory() {
        assert_eq!(
            concat_fragment_entry(
                Path::new("recording/segment/audio.m4a"),
                Path::new("recording/segment/audio.concat.txt"),
            )
            .unwrap(),
            "file './audio.m4a'\n"
        );

        let directory = tempfile::tempdir().unwrap();
        let fragment = directory.path().join("input.m4a");
        let list = directory.path().join("other/output.concat.txt");
        assert_eq!(
            concat_fragment_entry(&fragment, &list).unwrap(),
            format!("file '{}'\n", fragment.display())
        );
    }

    #[test]
    fn concat_entries_escape_apostrophes_without_changing_parent_paths() {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().join("parent 'quoted'");
        assert_eq!(
            concat_fragment_entry(
                &parent.join("fragment 'quoted'.m4a"),
                &parent.join("output.concat.txt"),
            )
            .unwrap(),
            concat!(r"file './fragment '\''quoted'\''.m4a'", "\n")
        );
    }

    #[cfg(unix)]
    #[test]
    fn concat_relative_entries_cannot_be_interpreted_as_url_schemes() {
        assert_eq!(
            concat_fragment_entry(
                Path::new("recording/https:fragment.m4a"),
                Path::new("recording/output.concat.txt"),
            )
            .unwrap(),
            "file './https:fragment.m4a'\n"
        );
    }

    #[test]
    fn unrepresentable_concat_entries_fail_before_creating_the_list() {
        let directory = tempfile::tempdir().unwrap();
        let list = directory.path().join("output.concat.txt");
        for name in ["fragment\nname.m4a", "fragment\rname.m4a"] {
            assert!(write_concat_list(&[directory.path().join(name)], &list).is_err());
            assert!(!list.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn concat_entries_reject_non_unicode_names_without_lossy_conversion() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};

        let fragment =
            Path::new("recording").join(OsString::from_vec(b"fragment-\xff.m4a".to_vec()));
        assert!(matches!(
            concat_fragment_entry(&fragment, Path::new("recording/output.concat.txt")),
            Err(super::RemuxError::InvalidConcatPath(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn concat_entries_preserve_symlink_spelling() {
        let directory = tempfile::tempdir().unwrap();
        let actual = directory.path().join("actual");
        std::fs::create_dir(&actual).unwrap();
        std::fs::write(actual.join("fragment.m4a"), []).unwrap();
        let alias = directory.path().join("alias");
        std::os::unix::fs::symlink(&actual, &alias).unwrap();

        assert_eq!(
            concat_fragment_entry(
                &alias.join("fragment.m4a"),
                &directory.path().join("output.concat.txt"),
            )
            .unwrap(),
            "file './alias/fragment.m4a'\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn concat_input_rejects_non_unicode_paths_explicitly() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};

        let path = std::path::PathBuf::from(OsString::from_vec(b"input-\xff.concat.txt".to_vec()));
        assert!(matches!(
            super::open_input_with_format(&path, "concat", ffmpeg::Dictionary::new()),
            Err(super::RemuxError::Io(error))
                if error.kind() == std::io::ErrorKind::InvalidInput
        ));
    }

    fn encode_test_audio(directory: &Path) -> std::path::PathBuf {
        use crate::fragmented_audio::FragmentedAudioFile;
        use cap_media_info::AudioInfo;
        use ffmpeg::{ChannelLayout, format::Sample, format::sample::Type};

        let path = directory.join("fragment.m4a");
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 1);
        let mut output = FragmentedAudioFile::init(path.clone(), info).unwrap();
        for block in 0..10 {
            let mut frame =
                ffmpeg::frame::Audio::new(Sample::F32(Type::Packed), 1024, ChannelLayout::MONO);
            frame.set_rate(48_000);
            frame.set_pts(Some(block * 1024));
            for (index, value) in frame.data_mut(0)[..1024 * 4]
                .chunks_exact_mut(4)
                .enumerate()
            {
                let position = (block * 1024) as f32 + index as f32;
                let sample = 0.25 * (position * 440.0 * std::f32::consts::TAU / 48_000.0).sin();
                value.copy_from_slice(&sample.to_ne_bytes());
            }
            output
                .queue_frame(
                    frame,
                    Duration::from_secs_f64(block as f64 * 1024.0 / 48_000.0),
                )
                .unwrap();
        }
        output.finish().unwrap().unwrap();
        path
    }

    fn assert_concat_roundtrip(parent_name: &str) {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().join(parent_name);
        std::fs::create_dir(&parent).unwrap();
        let timestamps: Vec<_> = (0..12)
            .map(|frame| Duration::from_nanos(frame * 1_000_000_000 / 30))
            .collect();
        let first = encode_test_mp4(&parent, &timestamps);
        let second = parent.join("second.mp4");
        std::fs::copy(&first, &second).unwrap();
        let output = parent.join("combined.mp4");
        concatenate_video_fragments(&[first, second], &output).unwrap();
        let mut input = ffmpeg::format::input(&output).unwrap();
        assert_eq!(input.packets().count(), 24);
        assert!(!output.with_extension("concat.txt").exists());

        let first = encode_test_audio(&parent.join("audio-input"));
        let second = parent.join("audio-input/second.m4a");
        std::fs::copy(&first, &second).unwrap();
        let output = parent.join("combined.ogg");
        concatenate_audio_to_ogg(&[first, second], &output).unwrap();
        let input = ffmpeg::format::input(&output).unwrap();
        let duration = input.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE);
        assert!((0.35..0.6).contains(&duration), "duration={duration}");
        assert!(!output.with_extension("concat.txt").exists());
    }

    fn first_video_pts_after(path: &Path, frames_before: usize) -> f64 {
        let (time_base, packets) = video_packet_contents(path);
        let mut pts: Vec<i64> = packets.iter().filter_map(|packet| packet.pts).collect();
        pts.sort_unstable();
        pts[frames_before] as f64 * f64::from(time_base)
    }

    fn timeline_inputs(parent: &Path, second_start_frame: u64) -> [PathBuf; 2] {
        let frames = |range: std::ops::Range<u64>| -> Vec<Duration> {
            range
                .map(|frame| Duration::from_nanos(frame * 1_000_000_000 / 30))
                .collect()
        };
        let first_dir = parent.join("first");
        let second_dir = parent.join("second");
        std::fs::create_dir_all(&first_dir).unwrap();
        std::fs::create_dir_all(&second_dir).unwrap();
        let second = second_dir.join("shifted.mp4");
        shift_test_mp4(
            &encode_test_mp4(&second_dir, &frames(0..12)),
            &second,
            second_start_frame as f64 / 30.0,
        );
        [encode_test_mp4(&first_dir, &frames(0..12)), second]
    }

    /// A copy of `input` whose packets start `offset` seconds later, like a
    /// replacement muxer's output on the recording's shared timeline.
    fn shift_test_mp4(input: &Path, output: &Path, offset: f64) {
        let mut ictx = ffmpeg::format::input(input).unwrap();
        let mut octx = ffmpeg::format::output(output).unwrap();
        let stream = ictx.streams().best(ffmpeg::media::Type::Video).unwrap();
        let (index, time_base) = (stream.index(), stream.time_base());
        let mut output_stream = octx.add_stream(None).unwrap();
        output_stream.set_parameters(stream.parameters());
        unsafe {
            (*output_stream.as_mut_ptr())
                .codecpar
                .as_mut()
                .unwrap()
                .codec_tag = 0;
        }
        octx.write_header().unwrap();
        let output_time_base = octx.stream(0).unwrap().time_base();
        let shift = (offset * f64::from(time_base.denominator()) / f64::from(time_base.numerator()))
            .round() as i64;
        for (stream, mut packet) in ictx.packets() {
            if stream.index() != index {
                continue;
            }
            packet.set_pts(packet.pts().map(|pts| pts + shift));
            packet.set_dts(packet.dts().map(|dts| dts + shift));
            packet.rescale_ts(time_base, output_time_base);
            packet.set_stream(0);
            packet.set_position(-1);
            packet.write_interleaved(&mut octx).unwrap();
        }
        octx.write_trailer().unwrap();
    }

    #[test]
    fn timeline_concat_keeps_a_later_file_at_its_start_time() {
        let directory = tempfile::tempdir().unwrap();
        let inputs = timeline_inputs(directory.path(), 30);
        let start = |path: &Path| {
            super::container_start_time(&ffmpeg::format::input(path).unwrap()) as f64
                / f64::from(ffmpeg::ffi::AV_TIME_BASE)
        };
        assert!(
            (start(&inputs[1]) - 1.0).abs() < 0.002,
            "{}",
            start(&inputs[1])
        );

        let joined = directory.path().join("timeline.mp4");
        concatenate_video_fragments_on_timeline(&inputs, &joined).unwrap();
        let second_at = first_video_pts_after(&joined, 12);
        assert!(
            (second_at - 1.0).abs() < 0.002,
            "second file starts at {second_at}"
        );
        assert_eq!(video_packet_contents(&joined).1.len(), 24);
        assert!(!joined.with_extension("concat.txt").exists());

        let end_to_end = directory.path().join("end-to-end.mp4");
        concatenate_video_fragments(&inputs, &end_to_end).unwrap();
        assert!(first_video_pts_after(&end_to_end, 12) < 0.5);
    }

    #[test]
    fn timeline_concat_plays_overlapping_files_end_to_end() {
        let directory = tempfile::tempdir().unwrap();
        let inputs = timeline_inputs(directory.path(), 6);

        let joined = directory.path().join("timeline.mp4");
        concatenate_video_fragments_on_timeline(&inputs, &joined).unwrap();
        let packets = video_packet_contents(&joined).1;
        assert_eq!(packets.len(), 24);
        let dts: Vec<i64> = packets.iter().filter_map(|packet| packet.dts).collect();
        assert!(dts.windows(2).all(|pair| pair[0] < pair[1]), "{dts:?}");
        let second_at = first_video_pts_after(&joined, 12);
        assert!(
            second_at >= 0.39,
            "overlap played over the first file: {second_at}"
        );
    }

    #[test]
    fn concat_audio_and_video_with_quoted_parent_directories() {
        assert_concat_roundtrip("recording 'quoted' λ");
    }

    #[cfg(unix)]
    #[test]
    fn concat_audio_and_video_with_newline_parent_directories() {
        assert_concat_roundtrip("recording\n");
    }

    /// Encodes a small mp4 whose frames are stamped with the given
    /// timestamps, mirroring how recordings reach disk.
    fn encode_test_mp4(dir: &std::path::Path, timestamps: &[Duration]) -> std::path::PathBuf {
        use crate::h264::H264Encoder;
        use crate::mp4::MP4File;
        use cap_media_info::VideoInfo;

        ffmpeg::init().ok();

        let video_info = VideoInfo {
            pixel_format: cap_media_info::Pixel::NV12,
            width: 320,
            height: 240,
            time_base: ffmpeg::Rational(1, 1_000_000),
            frame_rate: ffmpeg::Rational(30, 1),
        };

        let path = dir.join("ladder_probe_test.mp4");
        let mut file = MP4File::init(
            "ladder-probe-test",
            path.clone(),
            false,
            |o| H264Encoder::builder(video_info).build(o),
            |_| None,
        )
        .unwrap();

        for ts in timestamps {
            let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, 320, 240);
            for plane_idx in 0..frame.planes() {
                for byte in frame.data_mut(plane_idx).iter_mut() {
                    *byte = 128;
                }
            }
            file.queue_video_frame(frame, *ts).unwrap();
        }
        file.finish().unwrap();

        dir.join("ladder_probe_test.mp4")
    }

    /// A 60 fps capture of a mostly static screen: a burst of `burst`
    /// frames on the 60 fps grid, then a hold of `hold` intervals, repeated.
    fn bursty_timestamps(bursts: u64, burst: u64, hold: u64) -> Vec<Duration> {
        (0..bursts)
            .flat_map(|b| (0..burst).map(move |i| b * (burst + hold) + i))
            .map(|slot| Duration::from_nanos(slot * 1_000_000_000 / 60))
            .collect()
    }

    fn secs(timestamps: &[Duration]) -> Vec<f64> {
        timestamps.iter().map(Duration::as_secs_f64).collect()
    }

    #[test]
    fn capture_fps_of_a_bursty_capture_is_its_grid_not_its_average() {
        let timestamps = secs(&bursty_timestamps(20, 6, 30));
        let span = timestamps.last().unwrap() - timestamps[0];
        assert!(timestamps.len() as f64 / span < 12.0);
        assert_eq!(capture_fps_from_timestamps(timestamps), Some(60));
    }

    /// Up to `max` seconds either side of a frame's slot, uniformly.
    fn jitter(index: u64, max: f64) -> f64 {
        let mut x = index.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        (x >> 11) as f64 / (1u64 << 53) as f64 * 2.0 * max - max
    }

    #[test]
    fn capture_fps_absorbs_arrival_jitter() {
        for (fps, max) in [(30, 0.003), (60, 0.002), (120, 0.001)] {
            let timestamps = (0..600)
                .map(|i| i as f64 / f64::from(fps) + jitter(i, max))
                .collect();
            assert_eq!(capture_fps_from_timestamps(timestamps), Some(fps));
        }
        let bursts = bursty_timestamps(20, 6, 30)
            .iter()
            .enumerate()
            .map(|(i, t)| t.as_secs_f64() + jitter(i as u64, 0.0015))
            .collect();
        assert_eq!(capture_fps_from_timestamps(bursts), Some(60));
    }

    #[test]
    fn capture_fps_of_mostly_slower_content_is_its_fastest_run() {
        // A 60 fps capture of content that changes 30 times a second for
        // most of it, with idle holds and one 12-frame scroll at 60 fps.
        let mut timestamps = Vec::new();
        let mut t = 0.0;
        for burst in 0..200 {
            for i in 0..10 {
                t += 1.0 / 30.0;
                timestamps.push(t + jitter(burst * 10 + i, 0.0015));
            }
            t += 0.5;
        }
        for i in 0..12 {
            t += 1.0 / 60.0;
            timestamps.push(t + jitter(5000 + i, 0.001));
        }
        assert_eq!(capture_fps_from_timestamps(timestamps), Some(60));
    }

    #[test]
    fn capture_fps_ignores_the_short_gap_after_a_late_frame() {
        // 30 fps with every seventh frame late: 12 ms leaves a 21 ms gap
        // between a 45 ms one and a 33 ms one, 25 ms an 8 ms gap between a
        // 58 ms one and a 33 ms one.
        for late in [0.012, 0.025, 0.03] {
            let timestamps = (0..600u64)
                .map(|i| i as f64 / 30.0 + if i % 7 == 0 { late } else { 0.0 } + jitter(i, 0.001))
                .collect();
            assert_eq!(
                capture_fps_from_timestamps(timestamps),
                Some(30),
                "{late} s late"
            );
        }
    }

    #[test]
    fn capture_fps_of_changes_captured_in_pairs_is_the_pair_gap() {
        // A 60 fps capture of a screen that changes once a second, each
        // change captured as two frames.
        let timestamps = (0..40u64)
            .flat_map(|second| [0.0, 1.0 / 60.0].map(|offset| second as f64 + offset))
            .collect();
        assert_eq!(capture_fps_from_timestamps(timestamps), Some(60));
    }

    #[test]
    fn capture_fps_keeps_a_non_standard_rate() {
        let timestamps = (0..300).map(|i| f64::from(i) / 37.0).collect();
        assert_eq!(capture_fps_from_timestamps(timestamps), Some(37));
    }

    #[test]
    fn capture_fps_of_a_slow_capture_on_a_fine_grid_is_the_capture_rate() {
        // 30 fps frames stamped on a 120 Hz display's vsync grid, with holds:
        // r_frame_rate reads 120 here.
        let timestamps = (0..400u32)
            .map(|i| f64::from(i * 4 + (i / 20) * 40) / 120.0)
            .collect();
        assert_eq!(capture_fps_from_timestamps(timestamps), Some(30));
    }

    #[test]
    fn capture_fps_needs_enough_frames() {
        assert_eq!(
            capture_fps_from_timestamps((0..5).map(|i| f64::from(i) / 60.0).collect()),
            None
        );
    }

    #[test]
    fn capture_fps_reads_an_encoded_variable_rate_track() {
        let dir = tempfile::tempdir().unwrap();
        let path = encode_test_mp4(dir.path(), &bursty_timestamps(20, 6, 30));
        assert!(get_video_fps(&path).unwrap() < 12);
        assert_eq!(get_video_capture_fps(&path), Some(60));
    }

    #[test]
    fn ladder_probe_detects_synthetic_cfr_stamping() {
        let dir = tempfile::tempdir().unwrap();
        // The defective pipeline's output: exactly one nominal tick per
        // frame, regardless of how fast frames really arrived.
        let timestamps: Vec<Duration> = (0..120)
            .map(|i| Duration::from_nanos(i * 1_000_000_000 / 30))
            .collect();
        let path = encode_test_mp4(dir.path(), &timestamps);

        let probe = probe_video_pts_ladder(&path, 30).unwrap();
        assert!(
            probe.is_ladder(),
            "conforming {}/{}",
            probe.conforming,
            probe.deltas
        );
    }

    #[test]
    fn ladder_probe_tolerates_a_pause_gap() {
        let dir = tempfile::tempdir().unwrap();
        // A pause/resume leaves one oversized step in an otherwise perfect
        // ladder; the track is still synthetic.
        let timestamps: Vec<Duration> = (0..120)
            .map(|i| {
                let gap = if i >= 60 { 5_000_000_000u64 } else { 0 };
                Duration::from_nanos(i * 1_000_000_000 / 30 + gap)
            })
            .collect();
        let path = encode_test_mp4(dir.path(), &timestamps);

        let probe = probe_video_pts_ladder(&path, 30).unwrap();
        assert!(
            probe.is_ladder(),
            "conforming {}/{}",
            probe.conforming,
            probe.deltas
        );
    }

    #[test]
    fn ladder_probe_rejects_capture_timed_tracks() {
        let dir = tempfile::tempdir().unwrap();
        // Real capture timestamps jitter by milliseconds around the nominal
        // cadence; deterministic pseudo-jitter stands in for QPC noise.
        let timestamps: Vec<Duration> = (0..120)
            .map(|i| {
                let jitter_us = (i * 7919) % 7000; // 0..7ms
                Duration::from_nanos(i * 1_000_000_000 / 30 + jitter_us * 1_000)
            })
            .collect();
        let path = encode_test_mp4(dir.path(), &timestamps);

        let probe = probe_video_pts_ladder(&path, 30).unwrap();
        assert!(
            !probe.is_ladder(),
            "conforming {}/{}",
            probe.conforming,
            probe.deltas
        );
    }

    #[test]
    fn ladder_probe_rejects_faster_uniform_cadence() {
        let dir = tempfile::tempdir().unwrap();
        // A healed (or genuinely high-rate, correctly-timed) track is
        // uniform at a rate other than nominal — not the nominal ladder.
        let timestamps: Vec<Duration> = (0..120)
            .map(|i| Duration::from_nanos(i * 1_000_000_000 / 67))
            .collect();
        let path = encode_test_mp4(dir.path(), &timestamps);

        let probe = probe_video_pts_ladder(&path, 30).unwrap();
        assert!(
            !probe.is_ladder(),
            "conforming {}/{}",
            probe.conforming,
            probe.deltas
        );
    }

    #[test]
    fn seek_probe_positions_cover_start_middle_and_end() {
        let positions = build_seek_probe_positions(10_000_000, 6);

        assert_eq!(positions.first().copied(), Some(0));
        assert!(
            positions.iter().any(|p| *p >= 2_000_000 && *p <= 8_000_000),
            "expected an interior probe position"
        );
        assert!(
            positions.last().copied().unwrap_or_default() >= 9_000_000,
            "expected a near-end probe position"
        );
    }

    #[test]
    fn seek_probe_positions_are_sorted_and_unique() {
        let positions = build_seek_probe_positions(1_000_000, 12);

        assert!(!positions.is_empty());

        for window in positions.windows(2) {
            assert!(window[0] < window[1]);
        }
    }

    #[test]
    fn ordered_workers_report_the_first_error_by_position_for_uneven_batches() {
        let items = (0..8).collect::<Vec<i64>>();
        for workers in [1, 2, 3, 5, 8, 16] {
            let results = super::run_in_ordered_workers(&items, workers, |&item| {
                if item == 2 || item == 5 || item == 7 {
                    Err(format!("probe {item}"))
                } else {
                    Ok(item * 10)
                }
            });
            let expected = items
                .iter()
                .map(|&item| match item {
                    2 | 5 | 7 => Err(format!("probe {item}")),
                    _ => Ok(item * 10),
                })
                .collect::<Vec<_>>();
            assert_eq!(results, expected, "workers={workers}");
            assert_eq!(
                results.into_iter().collect::<Result<Vec<_>, _>>(),
                Err("probe 2".to_string()),
                "workers={workers}"
            );
        }
    }

    #[test]
    fn ordered_workers_turn_a_panicked_worker_into_errors_for_its_positions() {
        let items = (0..7).collect::<Vec<i64>>();
        let results = super::run_in_ordered_workers(&items, 3, |&item| {
            if item == 4 {
                panic!("decoder crashed");
            }
            Ok(item)
        });
        for (index, result) in results.iter().enumerate() {
            if index % 3 == 1 {
                assert_eq!(result, &Err("Seek probe worker panicked".to_string()));
            } else {
                assert_eq!(result, &Ok(index as i64));
            }
        }
    }

    #[test]
    fn ordered_workers_accept_empty_input() {
        let results = super::run_in_ordered_workers(&[] as &[i64], 4, |&item| Ok(item));
        assert!(results.is_empty());
    }
}
