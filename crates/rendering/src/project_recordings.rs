use std::{
    ffi::CString,
    path::{Path, PathBuf},
    ptr,
};

use cap_project::{AudioMeta, StudioRecordingMeta, VideoMeta};
use ffmpeg::Rescale;
use serde::Serialize;
use specta::Type;

pub(crate) fn open_headers(path: &Path) -> Option<ffmpeg::format::context::Input> {
    let path = CString::new(path.to_str()?).ok()?;
    let mut context = ptr::null_mut();
    let result = unsafe {
        ffmpeg::ffi::avformat_open_input(&mut context, path.as_ptr(), ptr::null(), ptr::null_mut())
    };

    if result < 0 {
        return None;
    }

    Some(unsafe { ffmpeg::format::context::Input::wrap(context) })
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn header_video_metadata(path: &Path) -> Option<(u32, u32, crate::cpu_yuv::YuvMatrix)> {
    let input = open_headers(path)?;
    let stream = input.streams().best(ffmpeg::media::Type::Video)?;
    let parameters = stream.parameters();
    let raw_parameters = unsafe { &*parameters.as_ptr() };
    if raw_parameters.width <= 0 || raw_parameters.height <= 0 {
        return None;
    }
    let video = ffmpeg::codec::Context::from_parameters(parameters)
        .and_then(|context| context.decoder().video())
        .ok()?;
    if video.width() == 0 || video.height() == 0 {
        return None;
    }

    Some((
        video.width(),
        video.height(),
        crate::cpu_yuv::YuvMatrix::from_color_space(video.color_space()),
    ))
}

fn header_duration_secs(input: &ffmpeg::format::context::Input) -> Option<f64> {
    let mut min_start = None;
    let mut max_end = None;
    let mut max_duration = 0_i64;

    for stream in input.streams() {
        let time_base = stream.time_base();
        let start_time = stream.start_time();
        let duration = stream.duration();

        if start_time != ffmpeg::ffi::AV_NOPTS_VALUE {
            let start = start_time.rescale(time_base, ffmpeg::rescale::TIME_BASE);
            min_start = Some(min_start.map_or(start, |min: i64| min.min(start)));

            if duration != ffmpeg::ffi::AV_NOPTS_VALUE {
                let duration = unsafe {
                    ffmpeg::ffi::av_rescale_q_rnd(
                        duration,
                        time_base.into(),
                        ffmpeg::ffi::AV_TIME_BASE_Q,
                        ffmpeg::ffi::AVRounding::AV_ROUND_NEAR_INF,
                    )
                };
                let end = start + duration;
                max_end = Some(max_end.map_or(end, |max: i64| max.max(end)));
            }
        }

        if duration != ffmpeg::ffi::AV_NOPTS_VALUE {
            let duration = duration.rescale(time_base, ffmpeg::rescale::TIME_BASE);
            max_duration = max_duration.max(duration);
        }
    }

    let duration = match (min_start, max_end) {
        (Some(start), Some(end)) if end - start > max_duration => end - start,
        _ => max_duration,
    };

    (duration > 0).then_some(duration as f64 / 1_000_000.0)
}

#[derive(Debug, Clone, Copy, Serialize, Type)]
pub struct Video {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub start_time: f64,
}

impl Video {
    pub fn new(path: impl AsRef<Path>, start_time: f64) -> Result<Self, String> {
        let path = path.as_ref();
        if path.is_dir() {
            let input = cap_video_decode::ffmpeg::open_fragmented_input(path)?;
            Self::from_input(input.input(), start_time)
        } else {
            if let Some(video) =
                open_headers(path).and_then(|input| Self::from_headers(&input, start_time))
            {
                return Ok(video);
            }

            let input = ffmpeg::format::input(path)
                .map_err(|error| format!("Failed to open video: {error}"))?;
            Self::from_input(&input, start_time)
        }
    }

    fn from_headers(input: &ffmpeg::format::context::Input, start_time: f64) -> Option<Self> {
        let stream = input.streams().best(ffmpeg::media::Type::Video)?;
        let parameters = stream.parameters();
        let parameters = unsafe { &*parameters.as_ptr() };

        if parameters.width <= 0 || parameters.height <= 0 {
            return None;
        }

        let rate = stream.avg_frame_rate();
        if rate.numerator() <= 0 || rate.denominator() <= 0 {
            return None;
        }

        let fps = rate.numerator() as f64 / rate.denominator() as f64;

        Some(Video {
            duration: header_duration_secs(input)?,
            width: parameters.width as u32,
            height: parameters.height as u32,
            fps: fps.round() as u32,
            start_time,
        })
    }

    pub fn from_input(
        input: &ffmpeg::format::context::Input,
        start_time: f64,
    ) -> Result<Self, String> {
        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or_else(|| "No video stream found".to_string())?;

        let decoder_ctx = ffmpeg::codec::Context::from_parameters(stream.parameters())
            .map_err(|e| format!("Failed to create decoder context: {e}"))?;

        // Probe-only fast path: read dimensions straight off the context; fall
        // back to opening the decoder when the probe did not supply them.
        let ctx_width = unsafe { (*decoder_ctx.as_ptr()).width };
        let ctx_height = unsafe { (*decoder_ctx.as_ptr()).height };
        let (width, height) = if ctx_width > 0 && ctx_height > 0 {
            (ctx_width as u32, ctx_height as u32)
        } else {
            let decoder = decoder_ctx
                .decoder()
                .video()
                .map_err(|e| format!("Failed to get video decoder: {e}"))?;
            let width = decoder.width();
            let height = decoder.height();
            if width == 0 || height == 0 {
                return Err("Invalid video dimensions".to_string());
            }
            (width, height)
        };

        if width == 0 || height == 0 {
            return Err("Invalid video dimensions".to_string());
        }

        let rate = stream.avg_frame_rate();
        let fps = if rate.denominator() != 0 {
            rate.numerator() as f64 / rate.denominator() as f64
        } else {
            30.0
        };

        let duration = {
            let container_duration = input.duration();
            if container_duration > 0 {
                container_duration as f64 / 1_000_000.0
            } else {
                let stream_duration = stream.duration();
                let time_base = stream.time_base();
                if stream_duration > 0 && time_base.denominator() > 0 {
                    stream_duration as f64 * time_base.numerator() as f64
                        / time_base.denominator() as f64
                } else {
                    return Err("Could not determine video duration".to_string());
                }
            }
        };

        Ok(Video {
            width,
            height,
            duration,
            fps: fps.round() as u32,
            start_time,
        })
    }

    pub fn fps(&self) -> u32 {
        self.fps
    }
}

#[derive(Debug, Clone, Copy, Serialize, Type)]
pub struct Audio {
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub start_time: f64,
}

impl Audio {
    pub fn new(path: impl AsRef<Path>, start_time: f64) -> Result<Self, String> {
        let path = path.as_ref();
        if let Some(audio) =
            open_headers(path).and_then(|input| Self::from_headers(&input, start_time))
        {
            return Ok(audio);
        }

        let input =
            ffmpeg::format::input(path).map_err(|e| format!("Failed to open audio: {e}"))?;
        Self::from_input(&input, start_time)
    }

    fn from_headers(input: &ffmpeg::format::context::Input, start_time: f64) -> Option<Self> {
        let stream = input.streams().best(ffmpeg::media::Type::Audio)?;
        let parameters = stream.parameters();
        let parameters = unsafe { &*parameters.as_ptr() };
        let sample_rate = u32::try_from(parameters.sample_rate)
            .ok()
            .filter(|sample_rate| *sample_rate > 0)?;
        let channels = u16::try_from(parameters.ch_layout.nb_channels)
            .ok()
            .filter(|channels| *channels > 0)?;

        Some(Audio {
            duration: header_duration_secs(input)?,
            sample_rate,
            channels,
            start_time,
        })
    }

    pub fn from_input(
        input: &ffmpeg::format::context::Input,
        start_time: f64,
    ) -> Result<Self, String> {
        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .ok_or_else(|| "No audio stream found".to_string())?;

        let audio_decoder = ffmpeg::codec::Context::from_parameters(stream.parameters())
            .map_err(|e| format!("Failed to create decoder: {e}"))?
            .decoder()
            .audio()
            .map_err(|e| format!("Failed to get audio decoder: {e}"))?;

        Ok(Audio {
            duration: input.duration() as f64 / 1_000_000.0,
            sample_rate: audio_decoder.rate(),
            channels: audio_decoder.channels(),
            start_time,
        })
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct ProjectRecordingsMeta {
    pub segments: Vec<SegmentRecordings>,
}

impl ProjectRecordingsMeta {
    pub fn new(recording_path: &PathBuf, meta: &StudioRecordingMeta) -> Result<Self, String> {
        meta.ensure_ordinary_media_access(recording_path)?;

        let segments = match &meta {
            StudioRecordingMeta::SingleSegment { segment: s } => {
                let display = Video::new(s.display.path.to_path(recording_path), 0.0)
                    .map_err(|e| format!("video / {e}"))?;
                let camera = s
                    .camera
                    .as_ref()
                    .map(|camera| Video::new(camera.path.to_path(recording_path), 0.0))
                    .transpose()
                    .map_err(|e| format!("camera / {e}"))?;
                let mic = s.audio.as_ref().and_then(|audio| {
                    match Audio::new(audio.path.to_path(recording_path), 0.0) {
                        Ok(audio) => Some(audio),
                        Err(e) => {
                            tracing::warn!(
                                "Failed to load mic audio for segment, treating as no audio: {e}"
                            );
                            None
                        }
                    }
                });

                vec![SegmentRecordings {
                    display,
                    camera,
                    mic,
                    system_audio: None,
                }]
            }
            StudioRecordingMeta::MultipleSegments { inner, .. } => inner
                .segments
                .iter()
                .map(|s| {
                    let ensure_start_time = |time: Option<f64>| match (s.display.start_time, time) {
                        (Some(_), None) => Err("Missing start time".to_string()),
                        (None, Some(_)) => Err("Start time mismatch".to_string()),
                        (_, time) => Ok(time.unwrap_or_default()),
                    };

                    let load_video = |meta: &VideoMeta| {
                        ensure_start_time(meta.start_time).and_then(|start_time| {
                            Video::new(meta.path.to_path(recording_path), start_time)
                        })
                    };

                    let load_audio = |meta: &AudioMeta| {
                        ensure_start_time(meta.start_time).and_then(|start_time| {
                            Audio::new(meta.path.to_path(recording_path), start_time)
                        })
                    };

                    if s.system_audio.is_some() && s.usable_system_audio().is_none() {
                        tracing::warn!("System audio start time does not match display, treating as no audio");
                    }
                    let system_audio = match Option::map(s.usable_system_audio(), load_audio)
                        .transpose()
                    {
                        Ok(audio) => audio,
                        Err(e) => {
                            tracing::warn!(
                                "Failed to load system audio for segment, treating as no audio: {e}"
                            );
                            None
                        }
                    };

                    Ok::<_, String>(SegmentRecordings {
                        display: load_video(&s.display).map_err(|e| format!("video / {e}"))?,
                        camera: Option::map(s.camera.as_ref(), load_video)
                            .transpose()
                            .map_err(|e| format!("camera / {e}"))?,
                        mic: match Option::map(s.mic.as_ref(), load_audio).transpose() {
                            Ok(audio) => audio,
                            Err(e) => {
                                tracing::warn!(
                                    "Failed to load mic audio for segment, treating as no audio: {e}"
                                );
                                None
                            }
                        },
                        system_audio,
                    })
                })
                .enumerate()
                .map(|(i, v)| v.map_err(|e| format!("segment {i} / {e}")))
                .collect::<Result<_, String>>()?,
        };

        Ok(Self { segments })
    }

    pub fn duration(&self) -> f64 {
        self.segments.iter().map(|s| s.duration()).sum()
    }

    pub fn get_source_duration(&self, path: &PathBuf) -> Result<f64, String> {
        Video::new(path, 0.0).map(|v| v.duration)
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct SegmentRecordings {
    pub display: Video,
    pub camera: Option<Video>,
    pub mic: Option<Audio>,
    pub system_audio: Option<Audio>,
}

impl SegmentRecordings {
    pub fn duration(&self) -> f64 {
        let mut duration_ns = [
            Some(self.display.duration),
            self.camera.as_ref().map(|s| s.duration),
            self.mic.as_ref().map(|s| s.duration),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        duration_ns.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        duration_ns[0]
    }
}

#[cfg(test)]
mod ordinary_media_access_tests {
    use super::{Audio, ProjectRecordingsMeta, Video, header_video_metadata, open_headers};
    use cap_project::StudioRecordingMeta;
    use std::path::{Path, PathBuf};

    fn write_video_packets(
        encoder: &mut ffmpeg::codec::encoder::video::Encoder,
        output: &mut ffmpeg::format::context::Output,
        stream_index: usize,
        output_time_base: ffmpeg::Rational,
    ) {
        let mut packet = ffmpeg::Packet::empty();
        while encoder.receive_packet(&mut packet).is_ok() {
            packet.set_stream(stream_index);
            packet.rescale_ts(encoder.time_base(), output_time_base);
            packet.write_interleaved(output).unwrap();
        }
    }

    fn write_audio_packets(
        encoder: &mut ffmpeg::codec::encoder::audio::Encoder,
        output: &mut ffmpeg::format::context::Output,
        stream_index: usize,
        output_time_base: ffmpeg::Rational,
    ) {
        let mut packet = ffmpeg::Packet::empty();
        while encoder.receive_packet(&mut packet).is_ok() {
            packet.set_stream(stream_index);
            packet.rescale_ts(encoder.time_base(), output_time_base);
            packet.write_interleaved(output).unwrap();
        }
    }

    fn write_test_video(path: &Path, codec_id: ffmpeg::codec::Id) {
        ffmpeg::init().unwrap();
        let codec = ffmpeg::encoder::find(codec_id).unwrap_or_else(|| {
            panic!("bundled FFmpeg has no encoder for video codec {codec_id:?}")
        });
        let mut output = ffmpeg::format::output_as(path, "mp4").unwrap();
        let global_header = output
            .format()
            .flags()
            .contains(ffmpeg::format::Flags::GLOBAL_HEADER);
        let (stream_index, mut encoder) = {
            let mut stream = output.add_stream(codec).unwrap();
            let stream_index = stream.index();
            stream.set_time_base((1, 30));
            stream.set_rate((30, 1));
            stream.set_avg_frame_rate((30, 1));
            let mut encoder = ffmpeg::codec::context::Context::new_with_codec(codec)
                .encoder()
                .video()
                .unwrap();
            encoder.set_width(64);
            encoder.set_height(48);
            encoder.set_format(ffmpeg::format::Pixel::YUV420P);
            encoder.set_frame_rate(Some((30, 1)));
            encoder.set_time_base((1, 30));
            if global_header {
                encoder.set_flags(ffmpeg::codec::Flags::GLOBAL_HEADER);
            }
            stream.set_parameters(&encoder);
            let encoder = encoder.open_as(codec).unwrap();
            stream.set_parameters(&encoder);
            (stream_index, encoder)
        };
        output.write_header().unwrap();
        let output_time_base = output.stream(stream_index).unwrap().time_base();

        let mut frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::YUV420P, 64, 48);
        frame.data_mut(0).fill(16);
        frame.data_mut(1).fill(128);
        frame.data_mut(2).fill(128);
        for pts in 0..45 {
            frame.set_pts(Some(pts));
            encoder.send_frame(&frame).unwrap();
            write_video_packets(&mut encoder, &mut output, stream_index, output_time_base);
        }

        encoder.send_eof().unwrap();
        write_video_packets(&mut encoder, &mut output, stream_index, output_time_base);
        output.write_trailer().unwrap();
    }

    fn write_test_audio(path: &Path) {
        ffmpeg::init().unwrap();
        let codec = ffmpeg::encoder::find(ffmpeg::codec::Id::PCM_S16LE).unwrap();
        let mut output = ffmpeg::format::output_as(path, "wav").unwrap();

        let mut encoder = ffmpeg::codec::context::Context::new_with_codec(codec)
            .encoder()
            .audio()
            .unwrap();
        encoder.set_rate(48_000);
        encoder.set_channel_layout(ffmpeg::ChannelLayout::STEREO);
        encoder.set_format(ffmpeg::format::Sample::I16(
            ffmpeg::format::sample::Type::Packed,
        ));
        encoder.set_time_base((1, 48_000));
        let mut encoder = encoder.open_as(codec).unwrap();
        let stream_index = {
            let mut stream = output.add_stream(codec).unwrap();
            let stream_index = stream.index();
            stream.set_time_base((1, 48_000));
            stream.set_parameters(&encoder);
            stream_index
        };
        output.write_header().unwrap();
        let output_time_base = output.stream(stream_index).unwrap().time_base();

        let mut frame = ffmpeg::frame::Audio::new(
            ffmpeg::format::Sample::I16(ffmpeg::format::sample::Type::Packed),
            72_000,
            ffmpeg::ChannelLayout::STEREO,
        );
        frame.set_rate(48_000);
        frame.set_pts(Some(0));
        frame.data_mut(0).fill(0);
        encoder.send_frame(&frame).unwrap();
        write_audio_packets(&mut encoder, &mut output, stream_index, output_time_base);
        encoder.send_eof().unwrap();
        write_audio_packets(&mut encoder, &mut output, stream_index, output_time_base);
        output.write_trailer().unwrap();
    }

    fn write_test_opus_ogg(path: &Path) {
        ffmpeg::init().unwrap();
        let codec = ffmpeg::encoder::find_by_name("libopus")
            .expect("bundled FFmpeg has no libopus encoder");
        let mut output = ffmpeg::format::output(path).unwrap();
        let (stream_index, mut encoder) = {
            let mut stream = output.add_stream(codec).unwrap();
            let stream_index = stream.index();
            stream.set_time_base((1, 48_000));
            let mut encoder = ffmpeg::codec::context::Context::new_with_codec(codec)
                .encoder()
                .audio()
                .unwrap();
            encoder.set_bit_rate(128_000);
            encoder.set_rate(48_000);
            encoder.set_format(ffmpeg::format::Sample::F32(
                ffmpeg::format::sample::Type::Packed,
            ));
            encoder.set_channel_layout(ffmpeg::ChannelLayout::MONO);
            encoder.set_time_base((1, 48_000));
            let encoder = encoder.open_as(codec).unwrap();
            stream.set_parameters(&encoder);
            (stream_index, encoder)
        };
        output.write_header().unwrap();
        let output_time_base = output.stream(stream_index).unwrap().time_base();

        for frame_index in 0..75 {
            let mut frame = ffmpeg::frame::Audio::new(
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                960,
                ffmpeg::ChannelLayout::MONO,
            );
            frame.set_rate(48_000);
            frame.set_pts(Some(frame_index * 960));
            frame.data_mut(0).fill(0);
            encoder.send_frame(&frame).unwrap();
            write_audio_packets(&mut encoder, &mut output, stream_index, output_time_base);
        }

        encoder.send_eof().unwrap();
        write_audio_packets(&mut encoder, &mut output, stream_index, output_time_base);
        output.write_trailer().unwrap();
    }

    fn write_test_fragmented_aac(path: &Path, frame_count: usize, write_trailer: bool) {
        ffmpeg::init().unwrap();
        let codec =
            ffmpeg::encoder::find_by_name("aac").expect("bundled FFmpeg has no AAC encoder");
        let mut output = ffmpeg::format::output_as(path, "mp4").unwrap();
        unsafe {
            let context = output.as_mut_ptr();
            assert_eq!(
                ffmpeg::ffi::av_opt_set(
                    (*context).priv_data,
                    c"movflags".as_ptr(),
                    c"frag_keyframe+empty_moov+default_base_moof+skip_trailer".as_ptr(),
                    0,
                ),
                0
            );
            assert_eq!(
                ffmpeg::ffi::av_opt_set_int(
                    (*context).priv_data,
                    c"frag_duration".as_ptr(),
                    2_000_000,
                    0,
                ),
                0
            );
            assert_eq!(
                ffmpeg::ffi::av_opt_set_int(context.cast(), c"flush_packets".as_ptr(), 1, 0,),
                0
            );
        }

        let (stream_index, mut encoder) = {
            let mut stream = output.add_stream(codec).unwrap();
            let stream_index = stream.index();
            stream.set_time_base((1, 48_000));
            let mut encoder = ffmpeg::codec::context::Context::new_with_codec(codec)
                .encoder()
                .audio()
                .unwrap();
            encoder.set_bit_rate(320_000);
            encoder.set_rate(48_000);
            encoder.set_format(ffmpeg::format::Sample::F32(
                ffmpeg::format::sample::Type::Planar,
            ));
            encoder.set_channel_layout(ffmpeg::ChannelLayout::STEREO);
            encoder.set_time_base((1, 48_000));
            let encoder = encoder.open_as(codec).unwrap();
            stream.set_parameters(&encoder);
            (stream_index, encoder)
        };
        output.write_header().unwrap();
        let output_time_base = output.stream(stream_index).unwrap().time_base();

        for frame_index in 0..frame_count {
            let mut frame = ffmpeg::frame::Audio::new(
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
                1024,
                ffmpeg::ChannelLayout::STEREO,
            );
            frame.set_rate(48_000);
            frame.set_pts(Some((frame_index * 1024) as i64));
            frame.data_mut(0).fill(0);
            frame.data_mut(1).fill(0);
            encoder.send_frame(&frame).unwrap();
            write_audio_packets(&mut encoder, &mut output, stream_index, output_time_base);
        }

        if write_trailer {
            encoder.send_eof().unwrap();
            write_audio_packets(&mut encoder, &mut output, stream_index, output_time_base);
            output.write_trailer().unwrap();
        }
    }

    fn assert_audio_metadata_eq(actual: Audio, expected: Audio, source: &str) {
        assert_eq!(
            actual.duration, expected.duration,
            "{source} duration differs: actual={actual:?}, expected={expected:?}"
        );
        assert_eq!(
            actual.sample_rate, expected.sample_rate,
            "{source} sample rate differs: actual={actual:?}, expected={expected:?}"
        );
        assert_eq!(
            actual.channels, expected.channels,
            "{source} channel count differs: actual={actual:?}, expected={expected:?}"
        );
    }

    #[test]
    fn failed_project_refuses_before_opening_invalid_media() {
        let meta: StudioRecordingMeta = serde_json::from_str(
            r#"{"segments":[{"display":{"path":"never-created/display.mp4"}}],"status":{"status":"Failed","error":"requested source failed"}}"#,
        ).unwrap();
        let error = match ProjectRecordingsMeta::new(&PathBuf::from("never-created-project"), &meta)
        {
            Ok(_) => panic!("failed recording unexpectedly accepted"),
            Err(error) => error,
        };
        assert!(error.contains("requested source failed"));
    }

    #[test]
    fn optional_system_audio_timestamps_do_not_reject_video_tracks() {
        let directory = tempfile::tempdir().unwrap();
        write_test_video(
            &directory.path().join("display.mp4"),
            ffmpeg::codec::Id::H264,
        );
        write_test_audio(&directory.path().join("audio.wav"));

        for (display_start, audio_start, matching) in [
            (None, Some(0.5), false),
            (Some(0.25), None, false),
            (None, None, true),
            (Some(0.25), Some(0.5), true),
        ] {
            for audio_path in ["missing.wav", "audio.wav"] {
                let raw = serde_json::json!({
                    "pretty_name": "Mixed timestamp recording",
                    "segments": [{
                        "display": {"path": "display.mp4", "start_time": display_start},
                        "camera": {"path": "display.mp4", "start_time": display_start},
                        "mic": {"path": "audio.wav", "start_time": display_start},
                        "system_audio": {"path": audio_path, "start_time": audio_start}
                    }]
                });
                std::fs::write(
                    directory.path().join("recording-meta.json"),
                    serde_json::to_vec(&raw).unwrap(),
                )
                .unwrap();
                let meta = cap_project::RecordingMeta::load_for_project(directory.path()).unwrap();
                let recordings =
                    ProjectRecordingsMeta::new(&meta.project_path, meta.studio_meta().unwrap())
                        .unwrap();
                let segment = &recordings.segments[0];
                let expected_start = display_start.unwrap_or_default();
                assert_eq!(segment.display.start_time, expected_start);
                assert_eq!(segment.camera.unwrap().start_time, expected_start);
                assert_eq!(segment.mic.unwrap().start_time, expected_start);
                assert_eq!(
                    segment.system_audio.map(|audio| audio.start_time),
                    (matching && audio_path == "audio.wav")
                        .then_some(audio_start.unwrap_or_default())
                );
            }
        }
    }

    #[test]
    fn inconsistent_camera_timestamps_still_return_an_error() {
        let directory = tempfile::tempdir().unwrap();
        write_test_video(
            &directory.path().join("display.mp4"),
            ffmpeg::codec::Id::H264,
        );

        for (display_start, camera_start) in [(None, Some(0.5)), (Some(0.25), None)] {
            let meta: StudioRecordingMeta = serde_json::from_value(serde_json::json!({
                "segments": [{
                    "display": {"path": "display.mp4", "start_time": display_start},
                    "camera": {"path": "display.mp4", "start_time": camera_start}
                }]
            }))
            .unwrap();
            let error =
                ProjectRecordingsMeta::new(&directory.path().to_path_buf(), &meta).unwrap_err();
            assert!(error.starts_with("segment 0 / camera / "), "{error}");
        }
    }

    #[test]
    fn h264_video_headers_match_full_probe() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("video.mp4");
        write_test_video(&path, ffmpeg::codec::Id::H264);

        let full_input = ffmpeg::format::input(&path).unwrap();
        let expected = Video::from_input(&full_input, 0.25).unwrap();
        let header_input = open_headers(&path).expect("header open should succeed");
        let actual =
            Video::from_headers(&header_input, 0.25).expect("video headers should be sufficient");

        assert_eq!(actual.width, expected.width);
        assert_eq!(actual.height, expected.height);
        assert_eq!(actual.fps, expected.fps);
        assert_eq!(actual.duration, expected.duration);
        assert_eq!(actual.start_time, expected.start_time);
    }

    #[test]
    fn mpeg4_video_falls_back_to_full_probe() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("video.mp4");
        write_test_video(&path, ffmpeg::codec::Id::MPEG4);

        let full_input = ffmpeg::format::input(&path).unwrap();
        let expected = Video::from_input(&full_input, 0.25).unwrap();
        let header_input = open_headers(&path).expect("header open should succeed");
        assert!(Video::from_headers(&header_input, 0.25).is_none());

        let actual = Video::new(&path, 0.25).unwrap();
        assert_eq!(actual.width, expected.width);
        assert_eq!(actual.height, expected.height);
        assert_eq!(actual.fps, expected.fps);
        assert_eq!(actual.duration, expected.duration);
        assert_eq!(actual.start_time, expected.start_time);
    }

    #[test]
    fn header_video_metadata_requires_codecpar_dimensions() {
        let directory = tempfile::tempdir().unwrap();
        let h264_path = directory.path().join("h264.mp4");
        let mpeg4_path = directory.path().join("mpeg4.mp4");
        write_test_video(&h264_path, ffmpeg::codec::Id::H264);
        write_test_video(&mpeg4_path, ffmpeg::codec::Id::MPEG4);

        assert_eq!(
            header_video_metadata(&h264_path).map(|(width, height, _)| (width, height)),
            Some((64, 48))
        );
        assert_eq!(header_video_metadata(&mpeg4_path), None);
    }

    #[test]
    fn audio_headers_match_full_probe() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("audio.wav");
        write_test_audio(&path);

        let full_input = ffmpeg::format::input(&path).unwrap();
        let expected = Audio::from_input(&full_input, 0.75).unwrap();
        let header_input = open_headers(&path).expect("header open should succeed");
        let actual =
            Audio::from_headers(&header_input, 0.75).expect("audio headers should be sufficient");

        assert_eq!(actual.sample_rate, expected.sample_rate);
        assert_eq!(actual.channels, expected.channels);
        assert_eq!(actual.duration, expected.duration);
        assert_eq!(actual.start_time, expected.start_time);
    }

    #[test]
    fn opus_ogg_headers_match_full_probe() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("audio-input.ogg");
        write_test_opus_ogg(&path);

        let full_input = ffmpeg::format::input(&path).unwrap();
        let expected = Audio::from_input(&full_input, 0.0).unwrap();
        let header_input = open_headers(&path).expect("header open should succeed");
        let from_headers =
            Audio::from_headers(&header_input, 0.0).expect("Opus headers should be sufficient");
        assert_audio_metadata_eq(from_headers, expected, "Opus header metadata");

        let actual = Audio::new(&path, 0.0).unwrap();
        assert_audio_metadata_eq(actual, expected, "Opus Audio::new metadata");
    }

    #[test]
    fn fragmented_aac_m4a_headers_match_full_probe() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("audio-input.m4a");
        write_test_fragmented_aac(&path, 72, true);

        let full_input = ffmpeg::format::input(&path).unwrap();
        let expected = Audio::from_input(&full_input, 0.0).unwrap();
        let header_input = open_headers(&path).expect("header open should succeed");
        let from_headers = Audio::from_headers(&header_input, 0.0)
            .expect("fragmented AAC M4A headers should be sufficient");
        assert_audio_metadata_eq(from_headers, expected, "fragmented AAC M4A header metadata");

        let actual = Audio::new(&path, 0.0).unwrap();
        assert_audio_metadata_eq(actual, expected, "fragmented AAC M4A Audio::new metadata");
    }

    #[test]
    fn incomplete_fragmented_aac_headers_fall_back_to_full_probe() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("incomplete.m4a");
        write_test_fragmented_aac(&path, 0, false);

        let header_input = open_headers(&path).expect("fragmented MP4 header should open");
        assert!(Audio::from_headers(&header_input, 0.0).is_none());

        let full_input = ffmpeg::format::input(&path).unwrap();
        let expected = Audio::from_input(&full_input, 0.0).unwrap();
        let actual = Audio::new(&path, 0.0).unwrap();
        assert_audio_metadata_eq(actual, expected, "incomplete fragmented AAC M4A fallback");
    }

    #[test]
    fn nonexistent_video_still_returns_an_error() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("missing.mp4");

        assert!(Video::new(path, 0.0).is_err());
    }
}
