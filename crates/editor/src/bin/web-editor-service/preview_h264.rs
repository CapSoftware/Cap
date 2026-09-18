use std::{collections::HashMap, time::Duration};

use cap_enc_ffmpeg::{
    h264::H264EncoderBuilder,
    h264_packet::{EncodedPacket, H264PacketEncoder},
};
use cap_media_info::{Pixel, VideoInfo};
use cap_rendering::RenderedFrame;
use ffmpeg::{Rational, format, frame};

pub struct PreviewH264Packet {
    pub data: Vec<u8>,
    pub sequence: u64,
    pub is_keyframe: bool,
    pub frame_number: u32,
    pub target_time_ns: u64,
}

pub struct PreviewH264Encoder {
    width: u32,
    height: u32,
    fps: u32,
    encoder: H264PacketEncoder,
    input: frame::Video,
    converted: Option<frame::Video>,
    pending: HashMap<i64, (u32, u64)>,
    frame_count: u64,
    packet_count: u64,
    codec: String,
    description: Vec<u8>,
}

impl PreviewH264Encoder {
    pub fn new(width: u32, height: u32, fps: u32, bpp: f32) -> Result<Self, String> {
        if width == 0
            || height == 0
            || !width.is_multiple_of(2)
            || !height.is_multiple_of(2)
            || !(1..=60).contains(&fps)
            || !(0.05..=0.18).contains(&bpp)
        {
            return Err("Unsupported H.264 preview dimensions or frame rate".to_string());
        }
        ffmpeg::init().map_err(|error| error.to_string())?;
        let encoder = H264EncoderBuilder::new(VideoInfo {
            pixel_format: Pixel::RGBA,
            width,
            height,
            time_base: Rational(1, 1_000_000),
            frame_rate: Rational(fps as i32, 1),
        })
        .with_bpp(bpp)
        .with_encoder_priority_override(&["libx264"])
        .build_standalone()
        .map_err(|error| error.to_string())?;
        let description = encoder.extradata();
        let sps_offset = description
            .windows(5)
            .position(|window| window == [0, 0, 0, 1, 0x67])
            .ok_or_else(|| "H.264 preview parameter sets are unavailable".to_string())?;
        if description.len() < sps_offset + 8 {
            return Err("H.264 preview profile is unavailable".to_string());
        }
        let codec = format!(
            "avc1.{:02X}{:02X}{:02X}",
            description[sps_offset + 5],
            description[sps_offset + 6],
            description[sps_offset + 7]
        );
        Ok(Self {
            width,
            height,
            fps,
            encoder,
            input: frame::Video::new(format::Pixel::RGBA, width, height),
            converted: None,
            pending: HashMap::new(),
            frame_count: 0,
            packet_count: 0,
            codec,
            description,
        })
    }

    pub fn codec(&self) -> &str {
        &self.codec
    }

    pub fn encode(&mut self, rendered: &RenderedFrame) -> Result<Vec<PreviewH264Packet>, String> {
        if rendered.width != self.width || rendered.height != self.height {
            return Err("H.264 preview dimensions changed".to_string());
        }
        let row_bytes = self.width as usize * 4;
        let source_stride = rendered.padded_bytes_per_row as usize;
        let destination_stride = self.input.stride(0);
        if source_stride < row_bytes
            || destination_stride < row_bytes
            || rendered.data.len() < source_stride * self.height as usize
        {
            return Err("H.264 preview frame buffer is invalid".to_string());
        }
        let destination = self.input.data_mut(0);
        for row in 0..self.height as usize {
            let source_start = row * source_stride;
            let destination_start = row * destination_stride;
            destination[destination_start..destination_start + row_bytes]
                .copy_from_slice(&rendered.data[source_start..source_start + row_bytes]);
        }
        let timestamp = Duration::from_micros(
            self.frame_count
                .saturating_mul(1_000_000)
                .saturating_div(self.fps as u64),
        );
        self.pending.insert(
            timestamp.as_micros() as i64,
            (rendered.frame_number, rendered.target_time_ns),
        );
        self.frame_count += 1;
        let mut encoded = Vec::<EncodedPacket>::new();
        self.encoder
            .encode_frame_reusable(&mut self.input, &mut self.converted, timestamp, |packet| {
                encoded.push(packet);
                Ok(())
            })
            .map_err(|error| error.to_string())?;
        let mut packets = Vec::with_capacity(encoded.len());
        for packet in encoded {
            let (frame_number, target_time_ns) = self
                .pending
                .remove(&packet.pts)
                .ok_or_else(|| "H.264 preview timestamp was invalid".to_string())?;
            let data = if packet.is_keyframe {
                let mut data = Vec::with_capacity(self.description.len() + packet.data.len());
                data.extend_from_slice(&self.description);
                data.extend_from_slice(&packet.data);
                data
            } else {
                packet.data
            };
            packets.push(PreviewH264Packet {
                data,
                sequence: self.packet_count,
                is_keyframe: packet.is_keyframe,
                frame_number,
                target_time_ns,
            });
            self.packet_count += 1;
        }
        Ok(packets)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use cap_rendering::RenderedFrame;

    use super::PreviewH264Encoder;

    #[test]
    fn padded_renderer_frames_encode_with_browser_configuration_and_frame_identity() {
        let mut encoder = PreviewH264Encoder::new(64, 64, 30, 0.18).unwrap();
        assert!(encoder.codec().starts_with("avc1."));
        let mut output = Vec::new();
        for frame_number in 0..35 {
            let mut data = vec![0; 64 * 320];
            for (row, pixels) in data.chunks_exact_mut(320).enumerate() {
                for (column, pixel) in pixels[..256].chunks_exact_mut(4).enumerate() {
                    pixel.copy_from_slice(&[
                        ((column + frame_number as usize) % 255) as u8,
                        ((row * 3 + frame_number as usize) % 255) as u8,
                        120,
                        255,
                    ]);
                }
            }
            output.extend(
                encoder
                    .encode(&RenderedFrame {
                        data: Arc::new(data),
                        width: 64,
                        height: 64,
                        padded_bytes_per_row: 320,
                        frame_number,
                        target_time_ns: frame_number as u64 * 1_000_000_000 / 30,
                    })
                    .unwrap(),
            );
        }
        assert!(output.len() >= 30);
        assert!(output[0].is_keyframe);
        assert!(output[0].data.starts_with(&[0, 0, 0, 1, 0x67]));
        for (sequence, packet) in output.iter().enumerate() {
            assert_eq!(packet.sequence, sequence as u64);
            assert_eq!(packet.frame_number, sequence as u32);
            assert_eq!(packet.target_time_ns, sequence as u64 * 1_000_000_000 / 30);
            assert!(!packet.data.is_empty());
        }
    }
}
