use ffmpeg::{
    codec::{context, encoder},
    format,
    frame::Packet,
    threading::Config,
};
use std::collections::VecDeque;
use tracing::{debug, info, trace};

use crate::{
    data::{AudioInfo, FFAudio, FFPacket, FFRational, PlanarData},
    pipeline::{audio_buffer::AudioBuffer, task::PipelineSinkTask},
    MediaError,
};

use super::Output;

pub struct OpusEncoder {
    tag: &'static str,
    encoder: encoder::Audio,
    output_ctx: format::context::Output,
    buffer: AudioBuffer,
    frame: FFAudio,
    packet: ffmpeg::Packet,
}

impl OpusEncoder {
    const OUTPUT_BITRATE: usize = 128 * 1000; // 128k

    pub fn init(tag: &'static str, config: AudioInfo, output: Output) -> Result<Self, MediaError> {
        let Output::File(destination) = output;
        let mut output_ctx = format::output(&destination)?;

        let codec = encoder::find_by_name("libopus")
            .ok_or(MediaError::TaskLaunch("Could not find Opus codec".into()))?;
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

        let encoder = encoder.open()?;

        let mut output_stream = output_ctx.add_stream(codec)?;
        output_stream.set_time_base(FFRational(1, config.rate()));
        output_stream.set_parameters(&encoder);
        output_ctx.write_header()?;

        let frame_size = encoder.frame_size() as usize;

        Ok(Self {
            tag,
            buffer: AudioBuffer::new(config, &encoder),
            encoder,
            output_ctx,
            frame: FFAudio::new(
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                frame_size,
                ffmpeg::ChannelLayout::default(config.channels as i32),
            ),
            packet: ffmpeg::Packet::empty(),
        })
    }

    fn queue_frame(&mut self, frame: FFAudio) {
        self.buffer.consume(frame);
        self.process_buffer();
    }

    fn process_buffer(&mut self) {
        while let Some(buffered_frame) = self.buffer.next_frame(false) {
            self.encoder.send_frame(buffered_frame).unwrap();
            self.process_packets();
        }
    }

    fn process_packets(&mut self) {
        while self.encoder.receive_packet(&mut self.packet).is_ok() {
            self.packet.set_stream(0);
            self.packet.write_interleaved(&mut self.output_ctx).unwrap();
        }
    }

    fn finish(&mut self) {
        self.process_buffer();
        self.encoder.send_eof().unwrap();
        self.process_packets();
        self.output_ctx.write_trailer().unwrap();
    }
}

impl PipelineSinkTask for OpusEncoder {
    type Input = FFAudio;

    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: &flume::Receiver<Self::Input>,
    ) {
        ready_signal.send(Ok(())).unwrap();

        while let Ok(frame) = input.recv() {
            self.queue_frame(frame);
        }
    }

    fn finish(&mut self) {
        self.finish();
    }
}
