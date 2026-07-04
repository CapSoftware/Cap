use std::time::Duration;

use ffmpeg::{
    Packet, Rational,
    codec::encoder,
    format::{self},
    frame,
};

pub struct EncoderBase {
    packet: ffmpeg::Packet,
    stream_index: usize,
    first_pts: Option<i64>,
    last_frame_pts: Option<i64>,
    last_written_dts: Option<i64>,
}

impl EncoderBase {
    pub(crate) fn new(stream_index: usize) -> Self {
        Self {
            packet: Packet::empty(),
            first_pts: None,
            last_frame_pts: None,
            stream_index,
            last_written_dts: None,
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

            let pts = (timestamp.as_secs_f64() * rate).round() as i64;
            let first_pts = self.first_pts.get_or_insert(pts);

            let pts = normalize_input_pts(
                pts - *first_pts,
                self.last_frame_pts,
                encoder.time_base(),
                encoder.frame_rate(),
            );
            self.last_frame_pts = Some(pts);
            frame.set_pts(Some(pts));
        } else {
            let Some(pts) = frame.pts() else {
                tracing::error!("Frame has no pts");
                return;
            };

            let first_pts = self.first_pts.get_or_insert(pts);

            let pts = normalize_input_pts(
                pts - *first_pts,
                self.last_frame_pts,
                encoder.time_base(),
                encoder.frame_rate(),
            );
            self.last_frame_pts = Some(pts);
            frame.set_pts(Some(pts));
        }
    }

    /// Stamps the frame's pts from its capture timestamp using an explicit
    /// tick rate. Audio input frames must be stamped in *input sample rate*
    /// units — the resampler rescales them to the encoder's output rate —
    /// whereas [`Self::update_pts`] uses the encoder's own (output) time
    /// base. Mixing the two conventions plays non-48kHz microphones at the
    /// wrong speed.
    pub fn update_pts_with_rate(
        &mut self,
        frame: &mut frame::Frame,
        timestamp: Duration,
        rate: f64,
    ) {
        if timestamp != Duration::MAX {
            let pts = (timestamp.as_secs_f64() * rate).round() as i64;
            let first_pts = *self.first_pts.get_or_insert(pts);
            let mut pts = pts - first_pts;
            if let Some(last) = self.last_frame_pts
                && pts <= last
            {
                pts = last + 1;
            }
            self.last_frame_pts = Some(pts);
            frame.set_pts(Some(pts));
        } else if let Some(pts) = frame.pts() {
            let first_pts = *self.first_pts.get_or_insert(pts);
            let mut pts = pts - first_pts;
            if let Some(last) = self.last_frame_pts
                && pts <= last
            {
                pts = last + 1;
            }
            self.last_frame_pts = Some(pts);
            frame.set_pts(Some(pts));
        } else {
            tracing::error!("Frame has no pts");
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

            match (self.packet.pts(), self.packet.dts()) {
                (Some(pts), None) => self.packet.set_dts(Some(pts)),
                (None, Some(dts)) => self.packet.set_pts(Some(dts)),
                _ => {}
            }

            if self.packet.duration() <= 0
                && let Some(duration) = nominal_packet_duration(
                    output.stream(self.stream_index).unwrap().time_base(),
                    encoder.frame_rate(),
                )
            {
                self.packet.set_duration(duration);
            }

            if let (Some(dts), Some(last_dts)) = (self.packet.dts(), self.last_written_dts)
                && dts <= last_dts
            {
                let fixed_dts = last_dts + 1;
                self.packet.set_dts(Some(fixed_dts));
                if let Some(pts) = self.packet.pts()
                    && pts < fixed_dts
                {
                    self.packet.set_pts(Some(fixed_dts));
                }
            }

            if let (Some(pts), Some(dts)) = (self.packet.pts(), self.packet.dts())
                && pts < dts
            {
                self.packet.set_pts(Some(dts));
            }

            self.last_written_dts = self.packet.dts();
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

fn nominal_packet_duration(time_base: Rational, frame_rate: Rational) -> Option<i64> {
    let time_base_num = time_base.numerator();
    let time_base_den = time_base.denominator();
    let frame_rate_num = frame_rate.numerator();
    let frame_rate_den = frame_rate.denominator();

    if time_base_num <= 0 || time_base_den <= 0 || frame_rate_num <= 0 || frame_rate_den <= 0 {
        return None;
    }

    let ticks = (frame_rate_den as f64 * time_base_den as f64)
        / (frame_rate_num as f64 * time_base_num as f64);
    ticks
        .is_finite()
        .then(|| ticks.round() as i64)
        .filter(|ticks| *ticks > 0)
}

fn normalize_input_pts(
    pts: i64,
    last_pts: Option<i64>,
    time_base: Rational,
    frame_rate: Rational,
) -> i64 {
    let Some(last_pts) = last_pts else {
        return pts;
    };

    if pts > last_pts {
        return pts;
    }

    last_pts + nominal_packet_duration(time_base, frame_rate).unwrap_or(1)
}
