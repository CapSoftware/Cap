use ffmpeg::{
    codec::{context, encoder},
    format,
    software::resampling::context::Context as ResampleContext,
    threading::Config,
};
use std::collections::VecDeque;

use crate::{
    data::{AudioInfo, FFAudio, FFPacket, FFRational, PlanarData},
    pipeline::task::PipelineSinkTask,
    MediaError, TARGET_SAMPLE_RATE,
};

use super::Output;

pub struct MP3Encoder {
    tag: &'static str,
    encoder: encoder::Audio,
    output_ctx: format::context::Output,
    buffer: AudioBuffer,
}

impl MP3Encoder {
    fn calculate_bitrate(config: &AudioInfo) -> usize {
        let base_bitrate = match config.rate() {
            rate if rate >= 44100 => 192_000,
            rate if rate >= 22050 => 128_000,
            _ => 96_000,
        };

        if config.channels == 1 {
            base_bitrate / 2
        } else {
            base_bitrate
        }
    }

    pub fn init(tag: &'static str, config: AudioInfo, output: Output) -> Result<Self, MediaError> {
        let Output::File(destination) = output;
        let mut output_ctx = format::output(&destination)?;

        let codec = encoder::find(ffmpeg::codec::Id::MP3)
            .ok_or(MediaError::TaskLaunch("Could not find MP3 codec".into()))?;
        let mut encoder_ctx = context::Context::new_with_codec(codec);
        encoder_ctx.set_threading(Config::count(4));
        let mut encoder = encoder_ctx.encoder().audio()?;

        let output_rate: i32 = TARGET_SAMPLE_RATE
            .try_into()
            .expect("Sample rate should fit in i32");

        encoder.set_bit_rate(Self::calculate_bitrate(&config));
        encoder.set_rate(output_rate);
        encoder.set_format(config.sample_format);
        encoder.set_channel_layout(config.channel_layout());
        encoder.set_time_base(FFRational(1, output_rate));

        let audio_encoder = encoder.open_as(codec)?;

        let mut output_stream = output_ctx.add_stream(codec)?;
        output_stream.set_time_base(FFRational(1, output_rate));
        output_stream.set_parameters(&audio_encoder);
        output_ctx
            .write_header()
            .map_err(|e| MediaError::TaskLaunch(format!("Failed to write MP3 header: {}", e)))?;

        Ok(Self {
            tag,
            buffer: AudioBuffer::new(config, output_rate, &audio_encoder),
            encoder: audio_encoder,
            output_ctx,
        })
    }

    fn queue_frame(&mut self, frame: FFAudio) {
        self.buffer.consume(frame);
        while let Some(buffered_frame) = self.buffer.next_frame() {
            if let Err(e) = self.encoder.send_frame(&buffered_frame) {
                eprintln!("Error sending frame to encoder: {}", e);
                continue;
            }
            self.process_packets();
        }
    }

    fn process_packets(&mut self) {
        let mut encoded_packet = FFPacket::empty();

        while self.encoder.receive_packet(&mut encoded_packet).is_ok() {
            encoded_packet.set_stream(0);
            encoded_packet.rescale_ts(
                encoded_packet.time_base(),
                self.output_ctx.stream(0).unwrap().time_base(),
            );
            if let Err(e) = encoded_packet.write_interleaved(&mut self.output_ctx) {
                eprintln!("Error writing packet: {}", e);
            }
        }
    }

    fn finish(&mut self) {
        self.encoder.send_eof().unwrap();
        self.process_packets();
        self.output_ctx.write_trailer().unwrap();
    }
}

impl PipelineSinkTask for MP3Encoder {
    type Input = FFAudio;

    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: flume::Receiver<Self::Input>,
    ) {
        println!("Starting {} audio encoding thread", self.tag);
        ready_signal.send(Ok(())).unwrap();

        while let Ok(frame) = input.recv() {
            self.queue_frame(frame);
        }

        println!("Received last {} sample. Finishing up encoding.", self.tag);
        self.finish();

        println!("Shutting down {} audio encoding thread", self.tag);
    }
}

struct AudioBuffer {
    current_pts: i64,
    data: Vec<VecDeque<u8>>,
    frame_size: usize,
    config: AudioInfo,
    resampler: Option<ResampleContext>,
    output_rate: i32,
}

impl AudioBuffer {
    fn new(config: AudioInfo, output_rate: i32, encoder: &encoder::Audio) -> Self {
        let sample_size = config.sample_size();
        let frame_buffer_size = usize::try_from(config.buffer_size).unwrap() * sample_size;

        let resampler = if config.rate() != output_rate {
            Some(
                ResampleContext::get(
                    config.sample_format,
                    config.channel_layout(),
                    config.rate().try_into().unwrap(),
                    config.sample_format,
                    config.channel_layout(),
                    output_rate.try_into().unwrap(),
                )
                .unwrap(),
            )
        } else {
            None
        };

        Self {
            current_pts: 0,
            data: vec![VecDeque::with_capacity(frame_buffer_size); config.channels],
            frame_size: encoder.frame_size().try_into().unwrap(),
            config,
            resampler,
            output_rate,
        }
    }

    fn is_empty(&self) -> bool {
        self.data[0].is_empty()
    }

    fn len(&self) -> usize {
        self.data[0].len()
    }

    fn consume(&mut self, frame: FFAudio) {
        for channel in 0..self.config.channels {
            self.data[channel].extend(frame.plane_data(channel));
        }
    }

    fn next_frame(&mut self) -> Option<FFAudio> {
        if self.is_empty() {
            return None;
        }

        let frame_size = self.frame_size * self.config.sample_size();
        if self.len() < frame_size {
            return None;
        }

        let mut input_frame = self.config.empty_frame(self.frame_size);
        input_frame.set_pts(Some(self.current_pts));

        for channel in 0..self.config.channels {
            for (index, byte) in self.data[channel].drain(0..frame_size).enumerate() {
                input_frame.plane_data_mut(channel)[index] = byte;
            }
        }

        // If we have a resampler, use it
        if let Some(resampler) = &mut self.resampler {
            // Create output frame with adjusted frame size for resampled data
            let output_samples = (self.frame_size as f64 * self.output_rate as f64
                / self.config.rate() as f64)
                .round() as usize;

            let mut output_frame = AudioInfo {
                channels: self.config.channels,
                sample_format: self.config.sample_format,
                buffer_size: self.config.buffer_size,
                time_base: FFRational(1, self.output_rate),
                sample_rate: self.output_rate.try_into().unwrap(),
            }
            .empty_frame(output_samples);

            // Resample the frame
            resampler.run(&input_frame, &mut output_frame).unwrap();

            // Set PTS based on output rate
            let output_pts = (self.current_pts as f64 * self.output_rate as f64
                / self.config.rate() as f64)
                .round() as i64;
            output_frame.set_pts(Some(output_pts));

            // Update PTS for next frame
            self.current_pts += i64::try_from(self.frame_size).unwrap();

            Some(output_frame)
        } else {
            // No resampling needed
            self.current_pts += i64::try_from(self.frame_size).unwrap();
            Some(input_frame)
        }
    }
}
