use std::time::Duration;

use ffmpeg::{
    Packet,
    codec::{context, encoder},
    format::{self, Sample, sample::Type},
    frame,
    threading::Config,
};

pub struct EncoderBase {
    packet: ffmpeg::Packet,
    stream_index: usize,
    first_pts: Option<i64>,
}

impl EncoderBase {
    pub(crate) fn new(stream_index: usize) -> Self {
        Self {
            packet: Packet::empty(),
            first_pts: None,
            stream_index,
        }
    }

    pub fn update_pts(
        &mut self,
        frame: &mut frame::Frame,
        timestamp: Duration,
        encoder: &mut encoder::encoder::Encoder,
    ) {
        if timestamp != Duration::MAX {
            let time_base = encoder.time_base();
            let rate = time_base.denominator() as f64 / time_base.numerator() as f64;
            frame.set_pts(Some((timestamp.as_secs_f64() * rate).round() as i64));
        } else {
            let Some(pts) = frame.pts() else {
                tracing::error!("Frame has no pts");
                return;
            };

            let first_pts = self.first_pts.get_or_insert(pts);

            frame.set_pts(Some(pts - *first_pts));
        }
    }

    pub fn send_frame(
        &mut self,
        frame: &frame::Frame,
        output: &mut format::context::Output,
        encoder: &mut encoder::encoder::Encoder,
    ) -> Result<(), ffmpeg::Error> {
        encoder.send_frame(frame)?;

        self.process_packets(output, encoder)
    }

    fn process_packets(
        &mut self,
        output: &mut format::context::Output,
        encoder: &mut encoder::encoder::Encoder,
    ) -> Result<(), ffmpeg::Error> {
        while encoder.receive_packet(&mut self.packet).is_ok() {
            self.packet.set_stream(self.stream_index);
            self.packet.rescale_ts(
                encoder.time_base(),
                output.stream(self.stream_index).unwrap().time_base(),
            );
            self.packet.write_interleaved(output)?;
        }

        Ok(())
    }

    pub fn process_eof(
        &mut self,
        output: &mut format::context::Output,
        encoder: &mut encoder::encoder::Encoder,
    ) -> Result<(), ffmpeg::Error> {
        encoder.send_eof()?;

        self.process_packets(output, encoder)
    }
}
