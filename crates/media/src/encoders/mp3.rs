use ffmpeg::{
    codec::{context, encoder},
    format,
    threading::Config,
};
use std::collections::VecDeque;

use crate::{
    data::{AudioInfo, FFAudio, FFPacket, FFRational, PlanarData},
    pipeline::task::PipelineSinkTask,
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

#[derive(Debug)]
struct AudioBuffer {
    current_pts: i64,
    data: Vec<VecDeque<u8>>,
    frame_size: usize,
    config: AudioInfo,
}

impl AudioBuffer {
    fn new(config: AudioInfo, encoder: &encoder::Audio) -> Self {
        let sample_size = config.sample_size();
        let frame_buffer_size = usize::try_from(config.buffer_size).unwrap() * sample_size;

        Self {
            current_pts: 0,
            data: vec![VecDeque::with_capacity(frame_buffer_size); config.channels],
            frame_size: encoder.frame_size().try_into().unwrap(),
            config,
        }
    }

    fn is_empty(&self) -> bool {
        self.data[0].is_empty()
    }

    fn len(&self) -> usize {
        self.data[0].len()
    }

    fn consume(&mut self, frame: FFAudio) {
        // TODO: Set PTS from frame with ffmpeg::sys::av_rescale_q??
        // if let Some(pts) = frame.pts() {
        //     self.current_pts = pts;
        // }
        for channel in 0..self.config.channels {
            // if self.current_pts == 0 {
            //     println!("Data in channel {channel}: {:?}", frame.data(channel));
            // }
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

        let mut frame = self.config.empty_frame(self.frame_size);
        frame.set_pts(Some(self.current_pts));

        for channel in 0..self.config.channels {
            for (index, byte) in self.data[channel].drain(0..frame_size).enumerate() {
                frame.plane_data_mut(channel)[index] = byte;
            }
        }

        self.current_pts += i64::try_from(frame_size / self.config.sample_size()).unwrap();
        Some(frame)
    }
}
