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
            match Self::init_with_codec("aac_at", options, bit_rate, input_config, output) {
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
                    .or(rates.first())
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
        let leading_trim = unsafe { (*encoder.as_ptr()).initial_padding }
            .saturating_sub(Self::FFMPEG_AAC_PRIMING)
            .max(0) as usize;

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
