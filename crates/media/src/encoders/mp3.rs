use ffmpeg::{
    codec::{context, encoder},
    format,
    threading::Config,
};
use std::collections::VecDeque;

use crate::{
    data::{AudioInfo, FFAudio, FFPacket, FFRational},
    pipeline::task::PipelineSinkTask,
    MediaError,
};

use super::Output;

pub struct MP3Encoder {
    tag: &'static str,
    encoder: encoder::Audio,
    output_ctx: format::context::Output,
    frame_size: usize,
    sample_size: usize,
    frame_buffer: VecDeque<u8>,
    next_pts: i64,
}

impl MP3Encoder {
    const OUTPUT_BITRATE: usize = 128 * 1000; // 128k

    pub fn init(tag: &'static str, config: AudioInfo, output: Output) -> Result<Self, MediaError> {
        let destination = match output {
            Output::File(path) => path,
        };
        let mut output_ctx = format::output(&destination)?;
        println!("Sample format: {:#?}", config.sample_format);

        let codec = encoder::find(ffmpeg::codec::Id::MP3)
            .ok_or(MediaError::TaskLaunch("Could not find MP3 codec".into()))?;
        let mut encoder_ctx = context::Context::new_with_codec(codec);
        encoder_ctx.set_threading(Config::count(4));
        let mut encoder = encoder_ctx.encoder().audio()?;

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

        let sample_size = config.sample_size();
        let frame_buffer_size = usize::try_from(config.buffer_size).unwrap() * sample_size;
        Ok(Self {
            tag,
            frame_size: audio_encoder.frame_size().try_into().unwrap(),
            sample_size,
            encoder: audio_encoder,
            output_ctx,
            frame_buffer: VecDeque::with_capacity(frame_buffer_size * 2),
            next_pts: 0,
        })
    }

    fn queue_frames_from_buffer(&mut self) {
        if self.frame_buffer.is_empty() {
            return;
        }

        let data_size = self.frame_size * self.sample_size;
        // let data_size = std::cmp::min(self.frame_size * self.sample_size, self.frame_buffer.len());
        let mut frame = FFAudio::new(
            self.encoder.format(),
            self.frame_size,
            self.encoder.channel_layout(),
        );
        frame.set_rate(self.encoder.rate());
        // TODO: Set first PTS with ffmpeg::sys::av_rescale_q??
        frame.set_pts(Some(self.next_pts));
        for (index, byte) in self.frame_buffer.drain(0..data_size).enumerate() {
            frame.data_mut(0)[index] = byte;
        }

        self.encoder.send_frame(&frame).unwrap();
        self.process_packets();
    }

    fn queue_frame(&mut self, frame: FFAudio) {
        self.frame_buffer.extend(frame.data(0));
        while self.frame_buffer.len() >= self.frame_size * self.sample_size {
            self.queue_frames_from_buffer();
            self.next_pts += i64::try_from(self.frame_size).unwrap();
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
        // self.queue_frames_from_buffer();
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
