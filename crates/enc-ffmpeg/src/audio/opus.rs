use cap_media_info::{AudioInfo, FFRational};
use ffmpeg::{
    codec::{context, encoder},
    format::{self, Sample, sample::Type},
    frame,
    threading::Config,
};

use crate::audio::buffered_resampler::BufferedResampler;

use super::AudioEncoder;

pub struct OpusEncoder {
    #[allow(unused)]
    tag: &'static str,
    encoder: encoder::Audio,
    packet: ffmpeg::Packet,
    resampler: BufferedResampler,
    stream_index: usize,
}

#[derive(thiserror::Error, Debug)]
pub enum OpusEncoderError {
    #[error("{0:?}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("Opus codec not found")]
    CodecNotFound,
    #[error("Sample rate not supported: {0}")]
    RateNotSupported(i32),
}

impl OpusEncoder {
    const OUTPUT_BITRATE: usize = 128 * 1000; // 128k
    const SAMPLE_FORMAT: Sample = Sample::F32(Type::Packed);

    pub fn factory(
        tag: &'static str,
        input_config: AudioInfo,
    ) -> impl FnOnce(&mut format::context::Output) -> Result<Self, OpusEncoderError> {
        move |o| Self::init(tag, input_config, o)
    }

    pub fn init(
        tag: &'static str,
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

        let resampler = ffmpeg::software::resampler(
            (
                input_config.sample_format,
                input_config.channel_layout(),
                input_config.sample_rate,
            ),
            (
                output_config.sample_format,
                output_config.channel_layout(),
                output_config.sample_rate,
            ),
        )
        .unwrap();
        let resampler = BufferedResampler::new(resampler);

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
            tag,
            encoder,
            stream_index,
            packet: ffmpeg::Packet::empty(),
            resampler,
        })
    }

    pub fn input_time_base(&self) -> FFRational {
        self.encoder.time_base()
    }

    pub fn queue_frame(&mut self, frame: frame::Audio, output: &mut format::context::Output) {
        self.resampler.add_frame(frame);

        let frame_size = self.encoder.frame_size() as usize;

        while let Some(frame) = self.resampler.get_frame(frame_size) {
            self.encoder.send_frame(&frame).unwrap();

            self.process_packets(output);
        }
    }

    fn process_packets(&mut self, output: &mut format::context::Output) {
        while self.encoder.receive_packet(&mut self.packet).is_ok() {
            self.packet.set_stream(self.stream_index);
            self.packet.rescale_ts(
                self.encoder.time_base(),
                output.stream(self.stream_index).unwrap().time_base(),
            );
            self.packet.write_interleaved(output).unwrap();
        }
    }

    pub fn finish(&mut self, output: &mut format::context::Output) {
        while let Some(frame) = self.resampler.flush(self.encoder.frame_size() as usize) {
            self.encoder.send_frame(&frame).unwrap();

            self.process_packets(output);
        }

        self.encoder.send_eof().unwrap();

        self.process_packets(output);
    }
}

impl AudioEncoder for OpusEncoder {
    fn queue_frame(&mut self, frame: frame::Audio, output: &mut format::context::Output) {
        self.queue_frame(frame, output);
    }

    fn finish(&mut self, output: &mut format::context::Output) {
        self.finish(output);
    }
}
