use std::{thread, time::Duration};

use cap_media_info::{AudioInfo, FFRational};
use ffmpeg::{
    codec::{context, encoder},
    format::{self, Sample, sample::Type},
    frame,
    threading::Config,
};

use super::AudioEncoder;
use crate::audio::{base::AudioEncoderBase, buffered_resampler::BufferedResampler};

pub struct OpusEncoder {
    base: AudioEncoderBase,
}

#[derive(thiserror::Error, Debug)]
pub enum OpusEncoderError {
    #[error("{0:?}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("Opus codec not found")]
    CodecNotFound,
    #[error("Sample rate not supported: {0}")]
    RateNotSupported(i32),
    #[error("Resampler: {0}")]
    Resampler(ffmpeg::Error),
}

impl OpusEncoder {
    const OUTPUT_BITRATE: usize = 128 * 1000; // 128k
    const SAMPLE_FORMAT: Sample = Sample::F32(Type::Packed);

    pub fn factory(
        input_config: AudioInfo,
    ) -> impl FnOnce(&mut format::context::Output) -> Result<Self, OpusEncoderError> {
        move |o| Self::init(input_config, o)
    }

    pub fn init(
        input_config: AudioInfo,
        output: &mut format::context::Output,
    ) -> Result<Self, OpusEncoderError> {
        let codec = encoder::find_by_name("libopus").ok_or(OpusEncoderError::CodecNotFound)?;
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

            select_output_rate(input_config.rate(), &rates)
                .ok_or(OpusEncoderError::RateNotSupported(input_config.rate()))?
        };

        let mut output_config = input_config;
        output_config.sample_format = Self::SAMPLE_FORMAT;
        output_config.sample_rate = rate as u32;

        let resampler = BufferedResampler::new(input_config, output_config)
            .map_err(OpusEncoderError::Resampler)?;

        encoder.set_bit_rate(Self::OUTPUT_BITRATE);
        encoder.set_rate(rate);
        encoder.set_format(output_config.sample_format);
        encoder.set_channel_layout(output_config.channel_layout());
        encoder.set_time_base(FFRational(1, output_config.rate()));

        let encoder = encoder.open()?;

        let mut output_stream = output.add_stream(codec)?;
        let stream_index = output_stream.index();
        output_stream.set_time_base(FFRational(1, output_config.rate()));
        output_stream.set_parameters(&encoder);

        Ok(Self {
            base: AudioEncoderBase::new(encoder, resampler, stream_index),
        })
    }

    pub fn queue_frame(
        &mut self,
        frame: frame::Audio,
        timestamp: Duration,
        output: &mut format::context::Output,
    ) -> Result<(), ffmpeg::Error> {
        self.base.send_frame(frame, timestamp, output)
    }

    pub fn finish(&mut self, output: &mut format::context::Output) -> Result<(), ffmpeg::Error> {
        self.base.finish(output)
    }
}

fn select_output_rate(input_rate: i32, supported_rates: &[i32]) -> Option<i32> {
    supported_rates
        .iter()
        .copied()
        .find(|&rate| rate >= input_rate)
        .or_else(|| supported_rates.iter().copied().max())
}

#[cfg(test)]
mod tests {
    use super::select_output_rate;

    #[test]
    fn chooses_matching_rate_when_available() {
        let supported = [8_000, 12_000, 16_000, 24_000, 48_000];
        assert_eq!(select_output_rate(16_000, &supported), Some(16_000));
    }

    #[test]
    fn clamps_to_highest_supported_rate_when_input_is_higher() {
        let supported = [8_000, 12_000, 16_000, 24_000, 48_000];
        assert_eq!(select_output_rate(96_000, &supported), Some(48_000));
    }

    #[test]
    fn clamps_to_lowest_supported_rate_when_input_is_lower() {
        let supported = [8_000, 12_000, 16_000, 24_000, 48_000];
        assert_eq!(select_output_rate(4_000, &supported), Some(8_000));
    }
}

impl AudioEncoder for OpusEncoder {
    fn send_frame(&mut self, frame: frame::Audio, output: &mut format::context::Output) {
        let _ = self.queue_frame(frame, Duration::MAX, output);
    }

    fn finish(&mut self, output: &mut format::context::Output) {
        let _ = self.finish(output);
    }
}
