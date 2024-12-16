use ffmpeg::{
    codec::{context, encoder},
    format,
    threading::Config,
};
use std::collections::VecDeque;

use crate::{
    data::{AudioInfo, FFAudio, FFPacket, FFRational, PlanarData},
    pipeline::{audio_buffer::AudioBuffer, task::PipelineSinkTask},
    MediaError,
};

use super::Output;

pub struct MP3Encoder {
    tag: &'static str,
    encoder: encoder::Audio,
    output_ctx: format::context::Output,
    buffer: AudioBuffer,
}

impl MP3Encoder {
    const OUTPUT_BITRATE: usize = 128 * 1000; // 128k

    pub fn init(tag: &'static str, config: AudioInfo, output: Output) -> Result<Self, MediaError> {
        let Output::File(destination) = output;
        let mut output_ctx = format::output(&destination)?;

        let codec = encoder::find(ffmpeg::codec::Id::MP3)
            .ok_or(MediaError::TaskLaunch("Could not find MP3 codec".into()))?;
        let mut encoder_ctx = context::Context::new_with_codec(codec);
        encoder_ctx.set_threading(Config::count(4));
        let mut encoder = encoder_ctx.encoder().audio()?;

        if !codec
            .audio()
            .unwrap()
            .rates()
            .into_iter()
            .flatten()
            .any(|r| r == config.rate())
        {
            return Err(MediaError::TaskLaunch(format!(
                "MP3 Codec does not support sample rate {}",
                config.rate()
            )));
        }

        encoder.set_bit_rate(Self::OUTPUT_BITRATE);
        encoder.set_rate(config.rate());
        encoder.set_format(config.sample_format);
        encoder.set_channel_layout(config.channel_layout());
        encoder.set_time_base(config.time_base);

        let audio_encoder = encoder.open()?;

        let mut output_stream = output_ctx.add_stream(codec)?;
        output_stream.set_time_base(FFRational(1, config.rate()));
        output_stream.set_parameters(&audio_encoder);
        output_ctx.write_header()?;

        Ok(Self {
            tag,
            buffer: AudioBuffer::new(config, &audio_encoder),
            encoder: audio_encoder,
            output_ctx,
        })
    }

    fn queue_frame(&mut self, frame: FFAudio) {
        self.buffer.consume(frame);
        while let Some(buffered_frame) = self.buffer.next_frame() {
            self.encoder.send_frame(&buffered_frame).unwrap();
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
            encoded_packet
                .write_interleaved(&mut self.output_ctx)
                .unwrap();
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
