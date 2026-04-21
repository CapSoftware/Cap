use std::time::Duration;

use ffmpeg::{
    Packet, Rational,
    codec::encoder,
    format::{self},
    frame,
};

use crate::video::h264::OpenedVideoEncoder;

pub struct H264PacketEncoder {
    encoder: encoder::Video,
    converter: Option<ffmpeg::software::scaling::Context>,
    converted_frame_pool: Option<frame::Video>,
    output_format: format::Pixel,
    output_width: u32,
    output_height: u32,
    input_format: format::Pixel,
    input_width: u32,
    input_height: u32,
    packet: Packet,
    first_pts: Option<i64>,
    last_written_dts: Option<i64>,
    encoder_time_base: Rational,
    frame_rate: Rational,
    codec_name: String,
}

#[derive(Debug, Clone)]
pub struct EncodedPacket {
    pub pts: i64,
    pub dts: i64,
    pub duration: i64,
    pub is_keyframe: bool,
    pub data: Vec<u8>,
}

#[derive(thiserror::Error, Debug)]
pub enum EncodePacketError {
    #[error("Converter: {0}")]
    Converter(ffmpeg::Error),
    #[error("Encode: {0}")]
    Encode(ffmpeg::Error),
}

impl H264PacketEncoder {
    pub(crate) fn from_opened(
        opened: OpenedVideoEncoder,
        codec_name: String,
        encoder_time_base: Rational,
        frame_rate: Rational,
    ) -> Self {
        Self {
            encoder: opened.encoder,
            converter: opened.converter,
            converted_frame_pool: opened.converted_frame_pool,
            output_format: opened.output_format,
            output_width: opened.output_width,
            output_height: opened.output_height,
            input_format: opened.input_format,
            input_width: opened.input_width,
            input_height: opened.input_height,
            packet: Packet::empty(),
            first_pts: None,
            last_written_dts: None,
            encoder_time_base,
            frame_rate,
            codec_name,
        }
    }

    pub fn codec_name(&self) -> &str {
        &self.codec_name
    }

    pub fn time_base(&self) -> Rational {
        self.encoder_time_base
    }

    pub fn frame_rate(&self) -> Rational {
        self.frame_rate
    }

    pub fn output_width(&self) -> u32 {
        self.output_width
    }

    pub fn output_height(&self) -> u32 {
        self.output_height
    }

    pub fn output_format(&self) -> format::Pixel {
        self.output_format
    }

    pub fn input_format(&self) -> format::Pixel {
        self.input_format
    }

    pub fn input_width(&self) -> u32 {
        self.input_width
    }

    pub fn input_height(&self) -> u32 {
        self.input_height
    }

    pub fn needs_conversion(&self) -> bool {
        self.converter.is_some()
    }

    pub fn extradata(&self) -> Vec<u8> {
        unsafe {
            let ctx = self.encoder.as_ptr();
            let size = (*ctx).extradata_size;
            let ptr = (*ctx).extradata;
            if ptr.is_null() || size <= 0 {
                return Vec::new();
            }
            std::slice::from_raw_parts(ptr, size as usize).to_vec()
        }
    }

    pub fn encode_frame<F>(
        &mut self,
        mut frame: frame::Video,
        timestamp: Duration,
        on_packet: F,
    ) -> Result<(), EncodePacketError>
    where
        F: FnMut(EncodedPacket) -> Result<(), EncodePacketError>,
    {
        self.update_pts(&mut frame, timestamp);

        let frame_to_send = if let Some(converter) = &mut self.converter {
            let pts = frame.pts();
            let converted = self.converted_frame_pool.as_mut().expect(
                "converted_frame_pool present whenever converter is Some (invariant preserved by from_opened)",
            );
            converter
                .run(&frame, converted)
                .map_err(EncodePacketError::Converter)?;
            converted.set_pts(pts);
            converted as &frame::Video
        } else {
            &frame
        };

        self.encoder
            .send_frame(frame_to_send)
            .map_err(EncodePacketError::Encode)?;

        self.drain_packets(on_packet)
    }

    pub fn encode_frame_reusable<F>(
        &mut self,
        frame: &mut frame::Video,
        converted_frame: &mut Option<frame::Video>,
        timestamp: Duration,
        on_packet: F,
    ) -> Result<(), EncodePacketError>
    where
        F: FnMut(EncodedPacket) -> Result<(), EncodePacketError>,
    {
        self.update_pts(frame, timestamp);

        let frame_to_send = if let Some(converter) = &mut self.converter {
            let pts = frame.pts();
            let converted = converted_frame.get_or_insert_with(|| {
                frame::Video::new(self.output_format, self.output_width, self.output_height)
            });
            converter
                .run(frame, converted)
                .map_err(EncodePacketError::Converter)?;
            converted.set_pts(pts);
            converted as &frame::Video
        } else {
            frame as &frame::Video
        };

        self.encoder
            .send_frame(frame_to_send)
            .map_err(EncodePacketError::Encode)?;

        self.drain_packets(on_packet)
    }

    pub fn flush<F>(&mut self, on_packet: F) -> Result<(), EncodePacketError>
    where
        F: FnMut(EncodedPacket) -> Result<(), EncodePacketError>,
    {
        self.encoder.send_eof().map_err(EncodePacketError::Encode)?;
        self.drain_packets(on_packet)
    }

    fn update_pts(&mut self, frame: &mut frame::Video, timestamp: Duration) {
        if timestamp != Duration::MAX {
            let tb = self.encoder.time_base();
            let rate = tb.denominator() as f64 / tb.numerator() as f64;
            let pts = (timestamp.as_secs_f64() * rate).round() as i64;
            let first_pts = self.first_pts.get_or_insert(pts);
            frame.set_pts(Some(pts - *first_pts));
        } else if let Some(pts) = frame.pts() {
            let first_pts = self.first_pts.get_or_insert(pts);
            frame.set_pts(Some(pts - *first_pts));
        } else {
            tracing::error!("Frame has no pts");
        }
    }

    fn drain_packets<F>(&mut self, mut on_packet: F) -> Result<(), EncodePacketError>
    where
        F: FnMut(EncodedPacket) -> Result<(), EncodePacketError>,
    {
        while self.encoder.receive_packet(&mut self.packet).is_ok() {
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

            let pts = self.packet.pts().unwrap_or(0);
            let dts = self.packet.dts().unwrap_or(pts);
            let duration = self.packet.duration();
            let is_keyframe = self.packet.is_key();
            let data = self.packet.data().map(|d| d.to_vec()).unwrap_or_default();

            on_packet(EncodedPacket {
                pts,
                dts,
                duration,
                is_keyframe,
                data,
            })?;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::h264::{H264EncoderBuilder, H264Preset};
    use cap_media_info::{Pixel, VideoInfo};

    fn test_video_info() -> VideoInfo {
        VideoInfo {
            pixel_format: Pixel::NV12,
            width: 320,
            height: 240,
            time_base: ffmpeg::Rational(1, 1_000_000),
            frame_rate: ffmpeg::Rational(30, 1),
        }
    }

    fn create_test_frame(width: u32, height: u32) -> frame::Video {
        let mut frame = frame::Video::new(format::Pixel::NV12, width, height);
        for plane_idx in 0..frame.planes() {
            let data = frame.data_mut(plane_idx);
            for byte in data.iter_mut() {
                *byte = 128;
            }
        }
        frame
    }

    #[test]
    fn standalone_builder_opens_encoder_and_produces_extradata() {
        ffmpeg::init().ok();

        let encoder = H264EncoderBuilder::new(test_video_info())
            .with_preset(H264Preset::Ultrafast)
            .build_standalone()
            .expect("standalone build succeeds");

        assert!(!encoder.codec_name().is_empty());
        let tb = encoder.time_base();
        assert!(tb.numerator() >= 1);
        assert!(tb.denominator() >= 1);

        let extra = encoder.extradata();
        assert!(
            !extra.is_empty() || encoder.codec_name() == "h264_videotoolbox",
            "expected extradata on open with GLOBAL_HEADER for {}",
            encoder.codec_name()
        );
    }

    #[test]
    fn standalone_encoder_produces_packets_on_frames_and_flush() {
        ffmpeg::init().ok();

        let mut encoder = H264EncoderBuilder::new(test_video_info())
            .with_preset(H264Preset::Ultrafast)
            .build_standalone()
            .expect("standalone build succeeds");

        let mut packets_seen = 0u32;
        for i in 0..10 {
            let frame = create_test_frame(320, 240);
            encoder
                .encode_frame(frame, Duration::from_millis(i * 33), |_pkt| {
                    packets_seen += 1;
                    Ok(())
                })
                .expect("encode succeeds");
        }

        encoder
            .flush(|_pkt| {
                packets_seen += 1;
                Ok(())
            })
            .expect("flush succeeds");

        assert!(
            packets_seen > 0,
            "expected at least one packet after encoding 10 frames + flush"
        );
    }
}
