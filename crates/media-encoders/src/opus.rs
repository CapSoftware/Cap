use cap_media_info::{AudioInfo, FFRational};
use ffmpeg::{
    codec::{context, encoder},
    format::{self, Sample, sample::Type},
    frame,
    threading::Config,
};
use std::{collections::VecDeque, path::PathBuf};

use super::AudioEncoder;

pub struct OggFile {
    encoder: OpusEncoder,
    output: format::context::Output,
}

impl OggFile {
    pub fn init(
        mut output: PathBuf,
        encoder: impl FnOnce(&mut format::context::Output) -> Result<OpusEncoder, OpusEncoderError>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        output.set_extension("ogg");
        let mut output = format::output(&output)?;

        let encoder = encoder(&mut output)?;

        // make sure this happens after adding all encoders!
        output.write_header()?;

        Ok(Self { encoder, output })
    }

    pub fn queue_frame(&mut self, frame: frame::Audio) {
        self.encoder.queue_frame(frame, &mut self.output);
    }

    pub fn finish(&mut self) {
        self.encoder.finish(&mut self.output);
        self.output.write_trailer().unwrap();
    }
}

pub struct OpusEncoder {
    #[allow(unused)]
    tag: &'static str,
    encoder: encoder::Audio,
    packet: ffmpeg::Packet,
    resampler: Option<ffmpeg::software::resampling::Context>,
    resampled_frame: frame::Audio,
    buffer: VecDeque<u8>,
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

        let resampler = if (
            input_config.sample_format,
            input_config.channel_layout(),
            input_config.sample_rate,
        ) != (
            output_config.sample_format,
            output_config.channel_layout(),
            output_config.sample_rate,
        ) {
            Some(
                ffmpeg::software::resampler(
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
                .unwrap(),
            )
        } else {
            None
        };

        encoder.set_bit_rate(Self::OUTPUT_BITRATE);
        encoder.set_rate(rate);
        encoder.set_format(output_config.sample_format);
        encoder.set_channel_layout(output_config.channel_layout());
        encoder.set_time_base(output_config.time_base);

        let encoder = encoder.open()?;

        let mut output_stream = output.add_stream(codec)?;
        let stream_index = output_stream.index();
        output_stream.set_time_base(FFRational(1, output_config.rate()));
        output_stream.set_parameters(&encoder);

        Ok(Self {
            tag,
            buffer: VecDeque::new(),
            encoder,
            stream_index,
            packet: ffmpeg::Packet::empty(),
            resampled_frame: frame::Audio::empty(),
            resampler,
        })
    }

    pub fn queue_frame(&mut self, frame: frame::Audio, output: &mut format::context::Output) {
        if let Some(resampler) = &mut self.resampler {
            resampler.run(&frame, &mut self.resampled_frame).unwrap();

            self.buffer
                .extend(&self.resampled_frame.data(0)[0..frame_size_bytes(&self.resampled_frame)]);

            loop {
                let frame_size_bytes = self.encoder.frame_size() as usize
                    * self.encoder.channels() as usize
                    * self.encoder.format().bytes();
                if self.buffer.len() < frame_size_bytes {
                    break;
                }

                let bytes = self.buffer.drain(0..frame_size_bytes).collect::<Vec<_>>();
                let mut frame = frame::Audio::new(
                    self.encoder.format(),
                    self.encoder.frame_size() as usize,
                    self.encoder.channel_layout(),
                );

                frame.data_mut(0)[0..frame_size_bytes].copy_from_slice(&bytes);

                self.encoder.send_frame(&frame).unwrap();

                self.process_packets(output);
            }
        } else {
            self.buffer
                .extend(&frame.data(0)[0..frame_size_bytes(&frame)]);

            loop {
                let frame_size_bytes = self.encoder.frame_size() as usize
                    * self.encoder.channels() as usize
                    * self.encoder.format().bytes();
                if self.buffer.len() < frame_size_bytes {
                    break;
                }

                let bytes = self.buffer.drain(0..frame_size_bytes).collect::<Vec<_>>();
                let mut frame = frame::Audio::new(
                    self.encoder.format(),
                    self.encoder.frame_size() as usize,
                    self.encoder.channel_layout(),
                );

                frame.data_mut(0)[0..frame_size_bytes].copy_from_slice(&bytes);

                self.encoder.send_frame(&frame).unwrap();

                self.process_packets(output);
            }
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
        let frame_size_bytes = self.encoder.frame_size() as usize
            * self.encoder.channels() as usize
            * self.encoder.format().bytes();

        if let Some(mut resampler) = self.resampler.take() {
            while resampler.delay().is_some() {
                resampler.flush(&mut self.resampled_frame).unwrap();
                if self.resampled_frame.samples() == 0 {
                    break;
                }

                self.buffer.extend(
                    &self.resampled_frame.data(0)[0..self.resampled_frame.samples()
                        * self.resampled_frame.channels() as usize
                        * self.resampled_frame.format().bytes()],
                );

                while self.buffer.len() >= frame_size_bytes {
                    let bytes = self.buffer.drain(0..frame_size_bytes).collect::<Vec<_>>();

                    let mut frame = frame::Audio::new(
                        self.encoder.format(),
                        self.encoder.frame_size() as usize,
                        self.encoder.channel_layout(),
                    );

                    frame.data_mut(0)[0..frame_size_bytes].copy_from_slice(&bytes);

                    self.encoder.send_frame(&frame).unwrap();

                    self.process_packets(output);
                }
            }

            while !self.buffer.is_empty() {
                let frame_size_bytes = frame_size_bytes.min(self.buffer.len());
                let frame_size = frame_size_bytes
                    / self.encoder.channels() as usize
                    / self.encoder.format().bytes();

                let bytes = self.buffer.drain(0..frame_size_bytes).collect::<Vec<_>>();

                let mut frame = frame::Audio::new(
                    self.encoder.format(),
                    frame_size,
                    self.encoder.channel_layout(),
                );

                frame.data_mut(0)[0..frame_size_bytes].copy_from_slice(&bytes);

                self.encoder.send_frame(&frame).unwrap();

                self.process_packets(output);
            }
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

fn frame_size_bytes(frame: &frame::Audio) -> usize {
    frame.samples() * frame.format().bytes() * frame.channels() as usize
}
