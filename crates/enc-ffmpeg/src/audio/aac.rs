use std::{thread, time::Duration};

use cap_media_info::{AudioInfo, FFRational};
use ffmpeg::{
    codec::{context, encoder},
    format::{self, Sample, sample::Type},
    frame,
    threading::Config,
};

use crate::{
    AudioEncoder,
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
}

impl AACEncoder {
    const OUTPUT_BITRATE: usize = 320 * 1000; // 128k
    const SAMPLE_FORMAT: Sample = Sample::F32(Type::Planar);

    pub fn factory(
        input_config: AudioInfo,
    ) -> impl FnOnce(&mut format::context::Output) -> Result<Self, AACEncoderError> {
        move |o| Self::init(input_config, o)
    }

    pub fn init(
        input_config: AudioInfo,
        output: &mut format::context::Output,
    ) -> Result<Self, AACEncoderError> {
        let codec = encoder::find_by_name("aac").ok_or(AACEncoderError::CodecNotFound)?;
        let mut encoder_ctx = context::Context::new_with_codec(codec);
        let thread_count = thread::available_parallelism()
            .map(|v| v.get())
            .unwrap_or(1);
        encoder_ctx.set_threading(Config::count(thread_count));
        let mut encoder = encoder_ctx.encoder().audio()?;

        let rate = {
            let mut rates = codec
                .audio()
                .unwrap()
                .rates()
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            rates.sort();

            let Some(&rate) = rates
                .iter()
                .find(|r| **r >= input_config.rate())
                .or(rates.first())
            else {
                return Err(AACEncoderError::RateNotSupported(input_config.rate()));
            };
            rate
        };

        let mut output_config = input_config;
        output_config.sample_format = Self::SAMPLE_FORMAT;
        output_config.sample_rate = rate as u32;

        let resampler = BufferedResampler::new(input_config, output_config)
            .map_err(AACEncoderError::Resampler)?;

        encoder.set_bit_rate(Self::OUTPUT_BITRATE);
        encoder.set_rate(rate);
        encoder.set_format(output_config.sample_format);
        encoder.set_channel_layout(output_config.channel_layout());
        encoder.set_time_base(FFRational(1, output_config.rate()));

        let encoder = encoder.open()?;

        let mut output_stream = output.add_stream(codec)?;
        output_stream.set_time_base(FFRational(1, output_config.rate()));
        output_stream.set_parameters(&encoder);

        Ok(Self {
            base: AudioEncoderBase::new(encoder, resampler, output_stream.index()),
        })
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

    #[test]
    fn checked_audio_submission_preserves_encoded_bytes() {
        assert_eq!(encode_audio(false), encode_audio(true));
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
