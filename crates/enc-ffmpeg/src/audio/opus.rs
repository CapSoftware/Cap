use std::time::Duration;

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
        encoder_ctx.set_threading(Config::count(4));
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
                return Err(OpusEncoderError::RateNotSupported(input_config.rate()));
            };
            rate
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

impl AudioEncoder for OpusEncoder {
    fn send_frame(&mut self, frame: frame::Audio, output: &mut format::context::Output) {
        let _ = self.queue_frame(frame, Duration::MAX, output);
    }

    fn finish(&mut self, output: &mut format::context::Output) {
        let _ = self.finish(output);
    }
}
