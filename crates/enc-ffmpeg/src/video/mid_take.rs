use std::time::Duration;

use cap_media_info::{AudioInfo, VideoInfo};
use ffmpeg::format::sample::{Sample, Type};
use ffmpeg::{ChannelLayout, Packet, Rational, frame};

use super::h264::{H264Encoder, QueueFrameError};
use crate::PacketSink;
use crate::aac::AACEncoder;

const FAILURE: ffmpeg::Error = ffmpeg::Error::Other {
    errno: ffmpeg::error::EIO,
};

#[test]
fn injected_mid_take_failure_keeps_video_and_audio_on_one_timeline() {
    ffmpeg::init().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("take.mp4");
    let mut output = ffmpeg::format::output(&path).unwrap();

    let audio_info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 2);
    let mut audio = AACEncoder::init(audio_info, &mut output).unwrap();
    let video = test_video();
    let video_index = add_h264_stream(&mut output, video.width, video.height, video.fps());
    assert_ne!(video_index, audio.stream_index());
    output.write_header().unwrap();

    let mut index = 0u64;
    let mut audio_samples = 0u64;
    {
        let mut sink = Interleaved {
            output: &mut output,
            video_index,
            last_video_dts: None,
        };
        let mut hardware = H264Encoder::builder(video)
            .build_software_on_stream(video_index, None)
            .unwrap();
        hardware.inject_codec_failure_after(30, FAILURE, None);

        loop {
            let timestamp = frame_timestamp(index);
            push_audio_until(&mut audio, &mut sink, &mut audio_samples, timestamp);
            match hardware.queue_frame_to(nv12_frame(16), timestamp, &mut sink) {
                Ok(()) => index += 1,
                Err(QueueFrameError::Encode(error)) if error == FAILURE => break,
                Err(error) => panic!("encode before the switch: {error}"),
            }
        }
        assert_eq!(index, 30, "the injected failure fires after 30 frames");
        let last_dts = sink.last_video_dts;
        let mut software = H264Encoder::builder(video)
            .build_software_on_stream(video_index, last_dts)
            .unwrap();
        let end = index + 30;
        while index < end {
            let timestamp = frame_timestamp(index);
            push_audio_until(&mut audio, &mut sink, &mut audio_samples, timestamp);
            software
                .queue_frame_to(nv12_frame(235), timestamp, &mut sink)
                .unwrap_or_else(|error| panic!("encode after the switch: {error}"));
            index += 1;
        }
        let end_timestamp = frame_timestamp(index.saturating_sub(1));
        push_audio_until(&mut audio, &mut sink, &mut audio_samples, end_timestamp);
        software.flush_to(&mut sink).unwrap();
        audio.flush_to(&mut sink).unwrap();
    }
    output.write_trailer().unwrap();
    drop(output);

    let decoded = decode_take(&path);
    assert!(
        decoded.dark_frames > 0 && decoded.bright_frames > 0,
        "both sides of the switch must decode, dark={} bright={}",
        decoded.dark_frames,
        decoded.bright_frames
    );
    assert!(
        decoded.video_errors == 0,
        "decoded video has {} frames with errors",
        decoded.video_errors
    );
    let video_pts = &decoded.video_timestamps;
    assert!(
        video_pts.len() >= 55,
        "video packets disappeared across the switch, got {}",
        video_pts.len()
    );
    let frame_secs = 1.0 / 30.0;
    let mut max_video_gap_secs = 0.0_f64;
    for pair in video_pts.windows(2) {
        assert!(
            pair[1] > pair[0],
            "video timestamp moved backwards: {:.6}s -> {:.6}s",
            pair[0],
            pair[1]
        );
        max_video_gap_secs = max_video_gap_secs.max(pair[1] - pair[0]);
    }
    assert!(
        max_video_gap_secs < frame_secs * 2.0,
        "video gap across the switch is {:.3}s",
        max_video_gap_secs
    );
    let duration_delta = (decoded.last_audio_secs - decoded.last_video_secs).abs();
    assert!(
        duration_delta < 0.1,
        "audio and video end {:.3}s apart (audio {:.3}s, video {:.3}s)",
        duration_delta,
        decoded.last_audio_secs,
        decoded.last_video_secs
    );
    assert!(
        decoded.max_audio_gap_secs < 0.05,
        "audio gap across the switch is {:.3}s",
        decoded.max_audio_gap_secs
    );
    assert!(decoded.audio_monotonic);
}

fn test_video() -> VideoInfo {
    VideoInfo {
        pixel_format: cap_media_info::Pixel::NV12,
        width: 320,
        height: 240,
        time_base: Rational(1, 1_000_000),
        frame_rate: Rational(30, 1),
    }
}

fn frame_timestamp(index: u64) -> Duration {
    Duration::from_micros(index * 33_333)
}

fn add_h264_stream(
    output: &mut ffmpeg::format::context::Output,
    width: u32,
    height: u32,
    fps: u32,
) -> usize {
    let codec = ffmpeg::codec::decoder::find(ffmpeg::codec::Id::H264).unwrap();
    let mut stream = output.add_stream(codec).unwrap();
    let index = stream.index();
    let time_base = Rational::new(1, fps as i32 * 1000);
    stream.set_time_base(time_base);
    unsafe {
        let codecpar = (*stream.as_mut_ptr()).codecpar;
        (*codecpar).codec_type = ffmpeg::ffi::AVMediaType::AVMEDIA_TYPE_VIDEO;
        (*codecpar).codec_id = ffmpeg::ffi::AVCodecID::AV_CODEC_ID_H264;
        (*codecpar).width = width as i32;
        (*codecpar).height = height as i32;
        (*codecpar).format = ffmpeg::ffi::AVPixelFormat::AV_PIX_FMT_NV12 as i32;
        (*stream.as_mut_ptr()).avg_frame_rate = ffmpeg::ffi::AVRational {
            num: fps as i32,
            den: 1,
        };
    }
    index
}

fn nv12_frame(y: u8) -> frame::Video {
    let mut frame = frame::Video::new(ffmpeg::format::Pixel::NV12, 320, 240);
    for plane in 0..frame.planes() {
        let value = if plane == 0 { y } else { 128 };
        frame.data_mut(plane).fill(value);
    }
    frame
}

fn push_audio_until(
    audio: &mut AACEncoder,
    sink: &mut Interleaved<'_>,
    audio_samples: &mut u64,
    until: Duration,
) {
    const RATE: u64 = 48_000;
    const SAMPLES: u64 = 1_024;
    while Duration::from_secs_f64(*audio_samples as f64 / RATE as f64) <= until {
        let mut frame = frame::Audio::new(
            Sample::F32(Type::Packed),
            SAMPLES as usize,
            ChannelLayout::STEREO,
        );
        frame.set_rate(RATE as u32);
        frame.data_mut(0).fill(0);
        let timestamp = Duration::from_secs_f64(*audio_samples as f64 / RATE as f64);
        audio
            .send_frame_to(frame, timestamp, sink)
            .unwrap_or_else(|error| panic!("audio encode: {error}"));
        *audio_samples += SAMPLES;
    }
}

struct Interleaved<'a> {
    output: &'a mut ffmpeg::format::context::Output,
    video_index: usize,
    last_video_dts: Option<i64>,
}

impl PacketSink for Interleaved<'_> {
    fn stream_time_base(&self, stream_index: usize) -> Rational {
        self.output.stream_time_base(stream_index)
    }

    fn write_packet(&mut self, packet: Packet) -> Result<(), ffmpeg::Error> {
        if packet.stream() == self.video_index {
            self.last_video_dts = packet.dts().or_else(|| packet.pts());
        }
        packet.write_interleaved(self.output)
    }
}

struct DecodedTake {
    dark_frames: usize,
    bright_frames: usize,
    video_errors: usize,
    video_timestamps: Vec<f64>,
    last_video_secs: f64,
    last_audio_secs: f64,
    max_audio_gap_secs: f64,
    audio_monotonic: bool,
}

fn decode_take(path: &std::path::Path) -> DecodedTake {
    let mut input = ffmpeg::format::input(path).unwrap();
    let video_index = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .unwrap()
        .index();
    let audio_index = input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .unwrap()
        .index();
    let video_tb = input.stream(video_index).unwrap().time_base();
    let audio_tb = input.stream(audio_index).unwrap().time_base();
    let video_params = input.stream(video_index).unwrap().parameters();
    let mut video_decoder = ffmpeg::codec::context::Context::from_parameters(video_params)
        .unwrap()
        .decoder()
        .video()
        .unwrap();

    let mut decoded = DecodedTake {
        dark_frames: 0,
        bright_frames: 0,
        video_errors: 0,
        video_timestamps: Vec::new(),
        last_video_secs: 0.0,
        last_audio_secs: 0.0,
        max_audio_gap_secs: 0.0,
        audio_monotonic: true,
    };
    let mut previous_audio = None;
    let mut frame = frame::Video::empty();
    for (stream, packet) in input.packets() {
        if stream.index() == audio_index {
            let Some(pts) = packet.pts() else {
                continue;
            };
            let secs =
                pts as f64 * f64::from(audio_tb.numerator()) / f64::from(audio_tb.denominator());
            if let Some(previous) = previous_audio {
                decoded.audio_monotonic &= secs + 0.000_1 >= previous;
                decoded.max_audio_gap_secs = decoded.max_audio_gap_secs.max(secs - previous);
            }
            previous_audio = Some(secs);
            decoded.last_audio_secs = decoded.last_audio_secs.max(secs);
            continue;
        }
        if stream.index() != video_index {
            continue;
        }
        let pts = packet.pts().expect("video packet has no timestamp");
        let secs = pts as f64 * f64::from(video_tb.numerator()) / f64::from(video_tb.denominator());
        decoded.video_timestamps.push(secs);
        decoded.last_video_secs = secs;
        video_decoder.send_packet(&packet).unwrap();
        while video_decoder.receive_frame(&mut frame).is_ok() {
            if unsafe { (*frame.as_ptr()).decode_error_flags } != 0 {
                decoded.video_errors += 1;
            }
            let data = frame.data(0);
            let y = data[data.len() / 2];
            if y < 40 {
                decoded.dark_frames += 1;
            } else if y > 200 {
                decoded.bright_frames += 1;
            }
        }
    }
    video_decoder.send_eof().unwrap();
    while video_decoder.receive_frame(&mut frame).is_ok() {
        if unsafe { (*frame.as_ptr()).decode_error_flags } != 0 {
            decoded.video_errors += 1;
        }
        let data = frame.data(0);
        let y = data[data.len() / 2];
        if y < 40 {
            decoded.dark_frames += 1;
        } else if y > 200 {
            decoded.bright_frames += 1;
        }
    }
    decoded
}
