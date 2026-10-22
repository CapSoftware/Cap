use std::{thread, time::Duration};

use cap_media_info::{AudioInfo, FFRational};
use ffmpeg::{
    codec::{context, encoder},
    format::{self, Sample, sample::Type},
    frame,
    threading::Config,
};

use crate::{
    AudioEncoder, PacketSink,
    audio::{base::AudioEncoderBase, buffered_resampler::BufferedResampler},
};

#[derive(thiserror::Error, Debug)]
pub enum AACEncoderError {
    #[error("{0:?}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("AAC codec not found")]
    CodecNotFound,
    #[error("Sample rate not supported: {0}")]
    RateNotSupported(i32),
    #[error("Resampler: {0}")]
    Resampler(ffmpeg::Error),
}

#[derive(Clone, Copy)]
enum Priming {
    Keep,
    TrimToFfmpegAac,
}

pub struct AACEncoder {
    base: AudioEncoderBase,
    stream_index: usize,
}

impl AACEncoder {
    const OUTPUT_BITRATE: usize = 320 * 1000; // 128k
    const SAMPLE_FORMAT: Sample = Sample::F32(Type::Planar);
    const FFMPEG_AAC_PRIMING: i32 = 1_024;

    pub fn factory(
        input_config: AudioInfo,
    ) -> impl FnOnce(&mut format::context::Output) -> Result<Self, AACEncoderError> {
        move |o| Self::init(input_config, o)
    }

    pub fn init(
        input_config: AudioInfo,
        output: &mut format::context::Output,
    ) -> Result<Self, AACEncoderError> {
        Self::init_with_codec(
            "aac",
            ffmpeg::Dictionary::new(),
            Self::OUTPUT_BITRATE,
            Priming::Keep,
            input_config,
            output,
        )
    }

    pub fn init_for_recording(
        input_config: AudioInfo,
        output: &mut format::context::Output,
    ) -> Result<Self, AACEncoderError> {
        let prefer_audiotoolbox = cfg!(target_os = "macos")
            && std::env::var_os("CAP_RECORDING_FFMPEG_AAC").is_none_or(|value| value.is_empty());
        Self::init_for_recording_with(prefer_audiotoolbox, input_config, output)
    }

    pub(crate) fn init_for_recording_with(
        prefer_audiotoolbox: bool,
        input_config: AudioInfo,
        output: &mut format::context::Output,
    ) -> Result<Self, AACEncoderError> {
        if prefer_audiotoolbox {
            let mut options = ffmpeg::Dictionary::new();
            options.set("aac_at_mode", "abr");
            let bit_rate = if input_config.channels == 1 {
                192_000
            } else {
                256_000
            };
            match Self::init_with_codec(
                "aac_at",
                options,
                bit_rate,
                Priming::TrimToFfmpegAac,
                input_config,
                output,
            ) {
                Ok(encoder) => return Ok(encoder),
                Err(error) => {
                    tracing::warn!(%error, "AudioToolbox AAC encoder unavailable, using FFmpeg's");
                }
            }
        }

        Self::init(input_config, output)
    }

    // A plain MP4's edit list skips AudioToolbox's 2112-sample encoder priming,
    // so exports keep every input sample instead of trimming like recordings.
    pub fn init_for_export(
        input_config: AudioInfo,
        output: &mut format::context::Output,
    ) -> Result<Self, AACEncoderError> {
        #[cfg(target_os = "macos")]
        {
            // AudioToolbox defaults to constant bitrate, which fills silence up to
            // the full 320 kbps; average bitrate keeps silent stretches near-free.
            let mut options = ffmpeg::Dictionary::new();
            options.set("aac_at_mode", "abr");
            match Self::init_with_codec(
                "aac_at",
                options,
                Self::OUTPUT_BITRATE,
                Priming::Keep,
                input_config,
                output,
            ) {
                Ok(encoder) => return Ok(encoder),
                Err(error) => {
                    tracing::warn!(%error, "AudioToolbox AAC encoder unavailable, using FFmpeg's");
                }
            }
        }

        Self::init(input_config, output)
    }

    fn init_with_codec(
        name: &str,
        options: ffmpeg::Dictionary,
        bit_rate: usize,
        priming: Priming,
        input_config: AudioInfo,
        output: &mut format::context::Output,
    ) -> Result<Self, AACEncoderError> {
        let codec = encoder::find_by_name(name).ok_or(AACEncoderError::CodecNotFound)?;
        let audio_codec = codec.audio()?;
        let mut encoder_ctx = context::Context::new_with_codec(codec);
        let thread_count = thread::available_parallelism()
            .map(|v| v.get())
            .unwrap_or(1);
        encoder_ctx.set_threading(Config::count(thread_count));
        let mut encoder = encoder_ctx.encoder().audio()?;

        let rate = {
            let mut rates = audio_codec
                .rates()
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            rates.sort();

            if rates.is_empty() {
                input_config.rate()
            } else {
                let Some(&rate) = rates
                    .iter()
                    .find(|r| **r >= input_config.rate())
                    .or(rates.last())
                else {
                    return Err(AACEncoderError::RateNotSupported(input_config.rate()));
                };
                rate
            }
        };

        let sample_format = {
            let formats = audio_codec
                .formats()
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            if formats.contains(&Self::SAMPLE_FORMAT) {
                Self::SAMPLE_FORMAT
            } else {
                formats.first().copied().unwrap_or(Self::SAMPLE_FORMAT)
            }
        };

        let mut output_config = input_config;
        output_config.sample_format = sample_format;
        output_config.sample_rate = rate as u32;

        let resampler = BufferedResampler::new(input_config, output_config)
            .map_err(AACEncoderError::Resampler)?;

        encoder.set_bit_rate(bit_rate);
        encoder.set_rate(rate);
        encoder.set_format(output_config.sample_format);
        encoder.set_channel_layout(output_config.channel_layout());
        encoder.set_time_base(FFRational(1, output_config.rate()));

        let encoder = encoder.open_with(options)?;

        // Fragmented outputs keep encoder priming in the decoded timeline;
        // dropping the priming a codec adds beyond FFmpeg's aac (e.g. 2112 vs
        // 1024 samples for aac_at) keeps every content sample where the native
        // encoder put it.
        let leading_trim = match priming {
            Priming::TrimToFfmpegAac => unsafe { (*encoder.as_ptr()).initial_padding }
                .saturating_sub(Self::FFMPEG_AAC_PRIMING)
                .max(0) as usize,
            Priming::Keep => 0,
        };

        let mut output_stream = output.add_stream(codec)?;
        output_stream.set_time_base(FFRational(1, output_config.rate()));
        output_stream.set_parameters(&encoder);

        let stream_index = output_stream.index();
        Ok(Self {
            base: AudioEncoderBase::new(encoder, resampler, stream_index)
                .with_leading_trim(leading_trim),
            stream_index,
        })
    }

    pub fn stream_index(&self) -> usize {
        self.stream_index
    }

    pub fn codec_name(&self) -> Option<String> {
        self.base.codec_name()
    }

    pub fn send_frame(
        &mut self,
        frame: frame::Audio,
        timestamp: Duration,
        output: &mut format::context::Output,
    ) -> Result<(), ffmpeg::Error> {
        self.base.send_frame(frame, timestamp, output)
    }

    pub fn flush(&mut self, output: &mut format::context::Output) -> Result<(), ffmpeg::Error> {
        self.base.flush(output)
    }

    pub fn send_frame_to(
        &mut self,
        frame: frame::Audio,
        timestamp: Duration,
        sink: &mut impl PacketSink,
    ) -> Result<(), ffmpeg::Error> {
        self.base.send_frame(frame, timestamp, sink)
    }

    pub fn flush_to(&mut self, sink: &mut impl PacketSink) -> Result<(), ffmpeg::Error> {
        self.base.flush(sink)
    }
}

impl AudioEncoder for AACEncoder {
    fn send_frame(&mut self, frame: frame::Audio, output: &mut format::context::Output) {
        let _ = self.send_frame(frame, Duration::MAX, output);
    }

    fn try_send_frame(
        &mut self,
        frame: frame::Audio,
        output: &mut format::context::Output,
    ) -> Result<(), ffmpeg::Error> {
        self.send_frame(frame, Duration::MAX, output)
    }

    fn flush(&mut self, output: &mut format::context::Output) -> Result<(), ffmpeg::Error> {
        self.flush(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ffmpeg::ChannelLayout;

    #[test]
    fn sample_rate_selection_preserves_supported_rates_and_clamps_outliers() {
        let directory = tempfile::tempdir().unwrap();
        for (input_rate, expected_rate) in [
            (4_000, 7_350),
            (44_100, 44_100),
            (45_000, 48_000),
            (96_000, 96_000),
            (192_000, 96_000),
        ] {
            let mut output =
                format::output(&directory.path().join(format!("{input_rate}.mp4"))).unwrap();
            let encoder = AACEncoder::init(
                AudioInfo::new_raw(Sample::F32(Type::Packed), input_rate, 1),
                &mut output,
            )
            .unwrap();
            let stream = output.stream(encoder.stream_index()).unwrap();
            let decoder = context::Context::from_parameters(stream.parameters())
                .unwrap()
                .decoder()
                .audio()
                .unwrap();
            assert_eq!(decoder.rate(), expected_rate, "input rate {input_rate}");
        }
    }

    #[test]
    fn high_rate_input_keeps_high_frequency_audio_through_encode_decode() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("high-rate.mp4");
        let mut output = format::output(&path).unwrap();
        let mut encoder = AACEncoder::init(
            AudioInfo::new_raw(Sample::F32(Type::Packed), 192_000, 1),
            &mut output,
        )
        .unwrap();
        output.write_header().unwrap();

        let mut audio = frame::Audio::new(Sample::F32(Type::Packed), 192_000, ChannelLayout::MONO);
        audio.set_rate(192_000);
        audio.set_pts(Some(0));
        for (index, sample) in audio.plane_mut::<f32>(0).iter_mut().enumerate() {
            *sample = 0.5 * (std::f32::consts::TAU * 12_000.0 * index as f32 / 192_000.0).sin();
        }
        encoder
            .send_frame(audio, Duration::MAX, &mut output)
            .unwrap();
        encoder.flush(&mut output).unwrap();
        output.write_trailer().unwrap();
        drop(encoder);
        drop(output);

        let (samples, track_end) = decode_first_channel(&path);
        assert_eq!(track_end, 48_000);
        assert!(samples.len() >= 96_000, "decoded {} samples", samples.len());
        let mut sine = 0.0;
        let mut cosine = 0.0;
        let signal = &samples[9_600..86_400];
        for (index, sample) in signal.iter().enumerate() {
            let phase = std::f64::consts::TAU * 12_000.0 * index as f64 / 96_000.0;
            sine += f64::from(*sample) * phase.sin();
            cosine += f64::from(*sample) * phase.cos();
        }
        let amplitude = 2.0 * sine.hypot(cosine) / signal.len() as f64;
        assert!(amplitude > 0.4, "12 kHz tone amplitude {amplitude}");
    }

    fn input_frame(start: i64, samples: usize) -> frame::Audio {
        let mut audio =
            frame::Audio::new(Sample::F32(Type::Packed), samples, ChannelLayout::STEREO);
        audio.set_rate(48_000);
        audio.set_pts(Some(start));
        for (index, sample) in audio.data_mut(0)[..samples * 2 * size_of::<f32>()]
            .chunks_exact_mut(size_of::<f32>())
            .enumerate()
        {
            let value = ((index % 17) as f32 - 8.0) / 32.0;
            sample.copy_from_slice(&value.to_le_bytes());
        }
        audio
    }

    fn encode_audio(checked: bool) -> Vec<u8> {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("audio.mp4");
        let mut output = format::output(&path).unwrap();
        let mut encoder = AACEncoder::init(
            AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 2),
            &mut output,
        )
        .unwrap();
        output.write_header().unwrap();

        let mut position = 0;
        for samples in [1, 997, 4_096, 1_024, 37] {
            let audio = input_frame(position, samples);
            if checked {
                AudioEncoder::try_send_frame(&mut encoder, audio, &mut output).unwrap();
            } else {
                AudioEncoder::send_frame(&mut encoder, audio, &mut output);
            }
            position += samples as i64;
        }

        encoder.flush(&mut output).unwrap();
        output.write_trailer().unwrap();
        drop(encoder);
        drop(output);
        std::fs::read(path).unwrap()
    }

    fn encode_audio_through_queue() -> Vec<u8> {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("audio.mp4");
        let mut output = format::output(&path).unwrap();
        let mut encoder = AACEncoder::init(
            AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 2),
            &mut output,
        )
        .unwrap();
        output.write_header().unwrap();

        let mut queue = crate::PacketQueue::new(output.stream_time_base(encoder.stream_index()));
        let mut position = 0;
        for samples in [1, 997, 4_096, 1_024, 37] {
            encoder
                .send_frame_to(input_frame(position, samples), Duration::MAX, &mut queue)
                .unwrap();
            for packet in queue.take() {
                output.write_packet(packet).unwrap();
            }
            position += samples as i64;
        }

        encoder.flush(&mut output).unwrap();
        output.write_trailer().unwrap();
        drop(encoder);
        drop(output);
        std::fs::read(path).unwrap()
    }

    fn encode_two_streams(queued_delay_batches: usize) -> Vec<u8> {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("two-streams.mp4");
        let mut output = format::output(&path).unwrap();
        let mut direct = AACEncoder::init(
            AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 2),
            &mut output,
        )
        .unwrap();
        let mut queued = AACEncoder::init(
            AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 2),
            &mut output,
        )
        .unwrap();
        output.write_header().unwrap();

        let mut queue = crate::PacketQueue::new(output.stream_time_base(queued.stream_index()));
        let mut delayed = std::collections::VecDeque::new();
        let mut position = 0;
        for index in 0..240 {
            let samples = [800, 801, 1_024, 997][index % 4];
            direct
                .send_frame(input_frame(position, samples), Duration::MAX, &mut output)
                .unwrap();
            queued
                .send_frame_to(input_frame(position, samples), Duration::MAX, &mut queue)
                .unwrap();
            delayed.push_back(queue.take());
            while delayed.len() > queued_delay_batches {
                for packet in delayed.pop_front().unwrap() {
                    output.write_packet(packet).unwrap();
                }
            }
            position += samples as i64;
        }
        for packet in delayed.into_iter().flatten() {
            output.write_packet(packet).unwrap();
        }

        direct.flush(&mut output).unwrap();
        queued.flush(&mut output).unwrap();
        output.write_trailer().unwrap();
        drop(direct);
        drop(queued);
        drop(output);
        std::fs::read(path).unwrap()
    }

    #[test]
    fn checked_audio_submission_preserves_encoded_bytes() {
        assert_eq!(encode_audio(false), encode_audio(true));
    }

    #[test]
    fn delayed_queued_packets_interleave_like_lockstep_writes() {
        let lockstep = encode_two_streams(0);
        assert_eq!(lockstep, encode_two_streams(1));
        assert_eq!(lockstep, encode_two_streams(120));
    }

    #[test]
    fn queued_audio_packets_match_direct_writes() {
        assert_eq!(encode_audio(true), encode_audio_through_queue());
    }

    const CLICKS: [usize; 2] = [240, 24_000];

    fn click_frame(start: usize, samples: usize) -> frame::Audio {
        let mut audio =
            frame::Audio::new(Sample::F32(Type::Packed), samples, ChannelLayout::STEREO);
        audio.set_rate(48_000);
        audio.set_pts(Some(start as i64));
        for (index, sample) in audio.data_mut(0)[..samples * 2 * size_of::<f32>()]
            .chunks_exact_mut(2 * size_of::<f32>())
            .enumerate()
        {
            let position = start + index;
            let value = if CLICKS
                .iter()
                .any(|click| (*click..click + 48).contains(&position))
            {
                0.9_f32
            } else {
                0.0
            };
            sample[..4].copy_from_slice(&value.to_le_bytes());
            sample[4..].copy_from_slice(&value.to_le_bytes());
        }
        audio
    }

    fn encode_clicks_for_export(path: &std::path::Path) {
        let mut output = format::output(path).unwrap();
        let mut encoder = AACEncoder::init_for_export(
            AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 2),
            &mut output,
        )
        .unwrap();
        output.write_header().unwrap();

        let mut position = 0;
        while position < 48_000 {
            let samples = 960.min(48_000 - position);
            encoder
                .send_frame(click_frame(position, samples), Duration::MAX, &mut output)
                .unwrap();
            position += samples;
        }

        encoder.flush(&mut output).unwrap();
        output.write_trailer().unwrap();
    }

    fn decode_first_channel(path: &std::path::Path) -> (Vec<f32>, i64) {
        use ffmpeg::Rescale;

        let mut input = format::input(path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Audio).unwrap();
        let stream_index = stream.index();
        let time_base = stream.time_base();
        let mut decoder = context::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .audio()
            .unwrap();
        let mut decoded = frame::Audio::empty();
        let mut samples = Vec::new();
        let mut track_end = i64::MIN;

        for (stream, packet) in input.packets() {
            if stream.index() != stream_index {
                continue;
            }
            if let Some(pts) = packet.pts() {
                track_end =
                    track_end.max((pts + packet.duration()).rescale(time_base, (1, 48_000)));
            }
            decoder.send_packet(&packet).unwrap();
            while decoder.receive_frame(&mut decoded).is_ok() {
                samples.extend_from_slice(decoded.plane::<f32>(0));
            }
        }
        decoder.send_eof().unwrap();
        while decoder.receive_frame(&mut decoded).is_ok() {
            samples.extend_from_slice(decoded.plane::<f32>(0));
        }
        (samples, track_end)
    }

    #[test]
    fn export_encoder_keeps_audio_aligned_in_mp4() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("clicks.mp4");
        encode_clicks_for_export(&path);

        let (samples, track_end) = decode_first_channel(&path);
        for encoded in CLICKS {
            let search_from = encoded.saturating_sub(64);
            let decoded = samples[search_from..]
                .iter()
                .position(|sample| sample.abs() > 0.3)
                .map(|offset| search_from + offset)
                .expect("the encoded click was not found");
            assert!(
                decoded.abs_diff(encoded) < 64,
                "click decoded at sample {decoded}, encoded at {encoded}"
            );
        }
        assert_eq!(track_end, 48_000);
    }

    #[test]
    fn export_encoder_spends_almost_nothing_on_silence() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("silence.mp4");
        let mut output = format::output(&path).unwrap();
        let mut encoder = AACEncoder::init_for_export(
            AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 2),
            &mut output,
        )
        .unwrap();
        output.write_header().unwrap();
        for start in (0..480_000).step_by(960) {
            let mut audio =
                frame::Audio::new(Sample::F32(Type::Packed), 960, ChannelLayout::STEREO);
            audio.set_rate(48_000);
            audio.set_pts(Some(start));
            audio.data_mut(0)[..960 * 2 * size_of::<f32>()].fill(0);
            encoder
                .send_frame(audio, Duration::MAX, &mut output)
                .unwrap();
        }
        encoder.flush(&mut output).unwrap();
        output.write_trailer().unwrap();
        drop(encoder);
        drop(output);

        let mut input = format::input(&path).unwrap();
        let stream_index = input
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .unwrap()
            .index();
        let bytes = input
            .packets()
            .filter(|(stream, _)| stream.index() == stream_index)
            .map(|(_, packet)| packet.size())
            .sum::<usize>();
        assert!(bytes < 40_000, "10 s of silence took {bytes} bytes");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn export_encoder_uses_audiotoolbox_on_macos() {
        let directory = tempfile::tempdir().unwrap();
        let mut output = format::output(&directory.path().join("audio.mp4")).unwrap();
        let encoder = AACEncoder::init_for_export(
            AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 2),
            &mut output,
        )
        .unwrap();
        assert_eq!(encoder.codec_name().as_deref(), Some("aac_at"));
    }

    #[test]
    #[ignore]
    fn benchmark_export_aac_encoder() {
        type Init =
            fn(AudioInfo, &mut format::context::Output) -> Result<AACEncoder, AACEncoderError>;

        fn voice_like_frame(start: usize, samples: usize, noise: &mut u32) -> frame::Audio {
            let mut audio =
                frame::Audio::new(Sample::F32(Type::Packed), samples, ChannelLayout::STEREO);
            audio.set_rate(48_000);
            audio.set_pts(Some(start as i64));
            for (index, sample) in audio.data_mut(0)[..samples * 2 * size_of::<f32>()]
                .chunks_exact_mut(size_of::<f32>())
                .enumerate()
            {
                *noise ^= *noise << 13;
                *noise ^= *noise >> 17;
                *noise ^= *noise << 5;
                let time = (start + index / 2) as f32 / 48_000.0;
                let value = 0.3 * (std::f32::consts::TAU * 220.0 * time).sin()
                    + 0.15 * (std::f32::consts::TAU * 1_330.0 * time).sin()
                    + 0.1 * (*noise as f32 / u32::MAX as f32 - 0.5);
                sample.copy_from_slice(&value.to_le_bytes());
            }
            audio
        }

        let seconds = std::env::var("CAP_AAC_BENCH_SECONDS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(60usize);
        let samples = seconds * 48_000;
        let directory = tempfile::tempdir().unwrap();
        let encoders: [(&str, Init); 2] = [
            ("init (FFmpeg aac)", AACEncoder::init),
            ("init_for_export", AACEncoder::init_for_export),
        ];
        for round in 0..3 {
            for (label, init) in encoders {
                let path = directory.path().join(format!("{round}.mp4"));
                let mut output = format::output(&path).unwrap();
                let mut encoder = init(
                    AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 2),
                    &mut output,
                )
                .unwrap();
                output.write_header().unwrap();
                let mut noise = 0x9e37_79b9_u32;
                let frames = (0..samples)
                    .step_by(960)
                    .map(|position| {
                        voice_like_frame(position, 960.min(samples - position), &mut noise)
                    })
                    .collect::<Vec<_>>();
                let started = std::time::Instant::now();
                for frame in frames {
                    encoder
                        .send_frame(frame, Duration::MAX, &mut output)
                        .unwrap();
                }
                encoder.flush(&mut output).unwrap();
                output.write_trailer().unwrap();
                let wall = started.elapsed().as_secs_f64();
                println!(
                    "round {round} {label}: {seconds}s of 48 kHz stereo in {wall:.3}s ({:.0}x realtime)",
                    seconds as f64 / wall
                );
            }
        }
    }

    #[test]
    fn checked_audio_submission_reports_a_closed_encoder() {
        let directory = tempfile::tempdir().unwrap();
        let mut output = format::output(&directory.path().join("closed.mp4")).unwrap();
        let mut encoder = AACEncoder::init(
            AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 2),
            &mut output,
        )
        .unwrap();
        output.write_header().unwrap();
        encoder.flush(&mut output).unwrap();

        assert_eq!(
            AudioEncoder::try_send_frame(&mut encoder, input_frame(0, 1_024), &mut output),
            Err(ffmpeg::Error::Eof)
        );
    }
}
