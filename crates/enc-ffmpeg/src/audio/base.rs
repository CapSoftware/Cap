use super::buffered_resampler::BufferedResampler;
use crate::base::{EncoderBase, PacketSink};
use ffmpeg::{
    Packet, Rational, Rescale,
    codec::{Capabilities, encoder},
    frame,
};
use std::time::Duration;

pub struct AudioEncoderBase {
    inner: EncoderBase,
    encoder: encoder::Audio,
    resampler: BufferedResampler,
    leading_trim: usize,
    input_end: Option<i64>,
}

impl AudioEncoderBase {
    pub fn new(encoder: encoder::Audio, resampler: BufferedResampler, stream_index: usize) -> Self {
        Self {
            inner: EncoderBase::new(stream_index),
            encoder,
            resampler,
            leading_trim: 0,
            input_end: None,
        }
    }

    pub fn with_leading_trim(mut self, samples: usize) -> Self {
        self.leading_trim = samples;
        self
    }

    pub fn codec_name(&self) -> Option<String> {
        self.encoder.codec().map(|codec| codec.name().to_owned())
    }

    pub fn send_frame<S: PacketSink + ?Sized>(
        &mut self,
        mut frame: frame::Audio,
        timestamp: Duration,
        output: &mut S,
    ) -> Result<(), ffmpeg::Error> {
        // Input frames are stamped in input-rate units; BufferedResampler
        // rescales them to the encoder's output rate. A source that changes
        // rate mid-stream moves that unit, so the stored state moves with it.
        let previous_rate = self.resampler.input().rate;
        let input_rate = if frame.rate() > 0 {
            frame.rate()
        } else {
            previous_rate
        };
        self.inner
            .rescale_input_rate(f64::from(previous_rate), f64::from(input_rate));
        self.inner
            .update_pts_with_rate(&mut frame, timestamp, f64::from(input_rate));

        self.resampler.add_frame(frame);

        if self.leading_trim > 0 {
            match self.resampler.get_frame(self.leading_trim) {
                Some(_) => self.leading_trim = 0,
                None => return Ok(()),
            }
        }

        while let Some(frame) = self.resampler.get_frame(self.encoder.frame_size() as usize) {
            self.track_input_end(&frame);
            self.inner.send_frame(&frame, output, &mut self.encoder)?;
        }

        Ok(())
    }

    pub fn flush<S: PacketSink + ?Sized>(&mut self, output: &mut S) -> Result<(), ffmpeg::Error> {
        while self.leading_trim > 0 {
            match self.resampler.flush(self.leading_trim) {
                Some(frame) => self.leading_trim -= frame.samples(),
                None => break,
            }
        }

        let mut frames = Vec::new();
        while let Some(frame) = self.resampler.flush(self.encoder.frame_size() as usize) {
            self.track_input_end(&frame);
            frames.push(frame);
        }

        // Encoders that only take full frames (AudioToolbox) get the last one
        // padded by libavcodec, and their packet durations count that padding,
        // so the track would end up to a frame after the input did.
        let pads_final_frame = self.encoder.codec().is_some_and(|codec| {
            !codec
                .capabilities()
                .intersects(Capabilities::SMALL_LAST_FRAME | Capabilities::VARIABLE_FRAME_SIZE)
        });
        let mut output = EndTrimmedSink {
            output,
            end: self.input_end.filter(|_| pads_final_frame),
            time_base: self.encoder.time_base(),
        };
        for frame in &frames {
            self.inner
                .send_frame(frame, &mut output, &mut self.encoder)?;
        }

        self.inner.process_eof(&mut output, &mut self.encoder)
    }

    fn track_input_end(&mut self, frame: &frame::Audio) {
        if let Some(pts) = frame.pts() {
            let end = pts + frame.samples() as i64;
            self.input_end = Some(self.input_end.map_or(end, |current| current.max(end)));
        }
    }
}

struct EndTrimmedSink<'a, S: PacketSink + ?Sized> {
    output: &'a mut S,
    end: Option<i64>,
    time_base: Rational,
}

impl<S: PacketSink + ?Sized> PacketSink for EndTrimmedSink<'_, S> {
    fn stream_time_base(&self, stream_index: usize) -> Rational {
        self.output.stream_time_base(stream_index)
    }

    fn write_packet(&mut self, mut packet: Packet) -> Result<(), ffmpeg::Error> {
        if let (Some(end), Some(pts)) = (self.end, packet.pts()) {
            let end = end.rescale(
                self.time_base,
                self.output.stream_time_base(packet.stream()),
            );
            if pts >= end {
                return Ok(());
            }
            if pts + packet.duration() > end {
                packet.set_duration(end - pts);
            }
        }
        self.output.write_packet(packet)
    }
}
