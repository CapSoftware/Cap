use cap_media_info::{AudioInfo, FFRational};
use ffmpeg::{
    codec::{context, encoder},
    format::{self, Sample, sample::Type},
    frame,
    threading::Config,
};
use std::collections::VecDeque;

use crate::AudioEncoder;

#[derive(thiserror::Error, Debug)]
pub enum AACEncoderError {
    #[error("{0:?}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("AAC codec not found")]
    CodecNotFound,
    #[error("Sample rate not supported: {0}")]
    RateNotSupported(i32),
}

pub struct AACEncoder {
    #[allow(unused)]
    tag: &'static str,
    encoder: encoder::Audio,
    packet: ffmpeg::Packet,
    resampler: Option<ffmpeg::software::resampling::Context>,
    resampled_frame: frame::Audio,
    buffer: Vec<VecDeque<u8>>,
    stream_index: usize,
}

impl AACEncoder {
    const OUTPUT_BITRATE: usize = 320 * 1000; // 128k
    const SAMPLE_FORMAT: Sample = Sample::F32(Type::Planar);

    pub fn factory(
        tag: &'static str,
        input_config: AudioInfo,
    ) -> impl FnOnce(&mut format::context::Output) -> Result<Self, AACEncoderError> {
        move |o| Self::init(tag, input_config, o)
    }

    pub fn init(
        tag: &'static str,
        input_config: AudioInfo,
        output: &mut format::context::Output,
    ) -> Result<Self, AACEncoderError> {
        let codec = encoder::find_by_name("aac").ok_or(AACEncoderError::CodecNotFound)?;
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
                return Err(AACEncoderError::RateNotSupported(input_config.rate()));
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
            buffer: vec![VecDeque::new(); 2],
            encoder,
            stream_index,
            packet: ffmpeg::Packet::empty(),
            resampled_frame: frame::Audio::empty(),
            resampler,
        })
    }

    pub fn queue_frame(&mut self, frame: frame::Audio, output: &mut format::context::Output) {
        let frame = if let Some(resampler) = &mut self.resampler {
            resampler.run(&frame, &mut self.resampled_frame).unwrap();
            &self.resampled_frame
        } else {
            &frame
        };

        for i in 0..frame.planes() {
            self.buffer[i]
                .extend(&frame.data(i)[0..frame_size_bytes(frame) / frame.channels() as usize]);
        }

        let channel_size_bytes = self.encoder.frame_size() as usize * self.encoder.format().bytes();

        loop {
            if self.buffer[0].len() < channel_size_bytes {
                break;
            }

            let mut frame = frame::Audio::new(
                self.encoder.format(),
                self.encoder.frame_size() as usize,
                self.encoder.channel_layout(),
            );

            for i in 0..frame.planes() {
                let bytes = self.buffer[i]
                    .drain(0..channel_size_bytes)
                    .collect::<Vec<_>>();

                frame.data_mut(i)[0..channel_size_bytes]
                    .copy_from_slice(&bytes[0..channel_size_bytes]);
            }

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
        let frame_size_bytes = self.encoder.frame_size() as usize
            * self.encoder.channels() as usize
            * self.encoder.format().bytes();

        if let Some(mut resampler) = self.resampler.take() {
            while resampler.delay().is_some() {
                resampler.flush(&mut self.resampled_frame).unwrap();
                if self.resampled_frame.samples() == 0 {
                    break;
                }

                for i in 0..self.resampled_frame.planes() {
                    self.buffer[i].extend(
                        &self.resampled_frame.data(0)[0..self.resampled_frame.samples()
                            * self.resampled_frame.format().bytes()],
                    );
                }

                while self.buffer.len() >= frame_size_bytes {
                    let mut frame = frame::Audio::new(
                        self.encoder.format(),
                        self.encoder.frame_size() as usize,
                        self.encoder.channel_layout(),
                    );

                    for i in 0..frame.planes() {
                        let bytes = self.buffer[i]
                            .drain(0..frame_size_bytes)
                            .collect::<Vec<_>>();

                        frame.data_mut(0)[0..frame_size_bytes].copy_from_slice(&bytes);
                    }

                    self.encoder.send_frame(&frame).unwrap();

                    self.process_packets(output);
                }
            }

            while !self.buffer[0].is_empty() {
                let channel_size_bytes =
                    (frame_size_bytes / self.encoder.channels() as usize).min(self.buffer[0].len());
                let frame_size = channel_size_bytes / self.encoder.format().bytes();

                let mut frame = frame::Audio::new(
                    self.encoder.format(),
                    frame_size,
                    self.encoder.channel_layout(),
                );

                for i in 0..frame.planes() {
                    let bytes = self.buffer[i]
                        .drain(0..channel_size_bytes)
                        .collect::<Vec<_>>();

                    frame.data_mut(i)[0..channel_size_bytes]
                        .copy_from_slice(&bytes[0..channel_size_bytes]);
                }

                self.encoder.send_frame(&frame).unwrap();

                self.process_packets(output);
            }
        }

        self.encoder.send_eof().unwrap();

        self.process_packets(output);
    }
}

impl AudioEncoder for AACEncoder {
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
