use cpal::{SampleFormat, SupportedBufferSize, SupportedStreamConfig};
use ffmpeg::frame;
pub use ffmpeg::{
    format::{
        pixel::Pixel,
        sample::{Sample, Type},
    },
    util::{channel_layout::ChannelLayout, rational::Rational as FFRational},
};

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub struct AudioInfo {
    pub sample_format: Sample,
    pub sample_rate: u32,
    pub channels: usize,
    pub time_base: FFRational,
    pub buffer_size: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum AudioInfoError {
    #[error("Unsupported number of channels: {0}")]
    ChannelLayout(u16),
}

impl AudioInfo {
    /// Maximum number of audio channels supported by FFmpeg channel layouts.
    /// Matches the highest channel count in `channel_layout_raw` (7.1 surround = 8 channels).
    pub const MAX_AUDIO_CHANNELS: u16 = 8;

    pub const fn new(
        sample_format: Sample,
        sample_rate: u32,
        channel_count: u16,
    ) -> Result<Self, AudioInfoError> {
        if Self::channel_layout_raw(channel_count).is_none() {
            return Err(AudioInfoError::ChannelLayout(channel_count));
        }

        Ok(Self {
            sample_format,
            sample_rate,
            channels: channel_count as usize,
            time_base: FFRational(1, 1_000_000),
            buffer_size: 1024,
        })
    }

    pub const fn new_raw(sample_format: Sample, sample_rate: u32, channel_count: u16) -> Self {
        Self {
            sample_format,
            sample_rate,
            channels: channel_count as usize,
            time_base: FFRational(1, 1_000_000),
            buffer_size: 1024,
        }
    }

    pub fn from_stream_config(config: &SupportedStreamConfig) -> Self {
        Self::from_stream_config_with_buffer(config, None)
    }

    pub fn from_stream_config_with_buffer(
        config: &SupportedStreamConfig,
        buffer_size_override: Option<u32>,
    ) -> Self {
        let sample_format = ffmpeg_sample_format_for(config.sample_format()).unwrap();
        let buffer_size = buffer_size_override.unwrap_or_else(|| match config.buffer_size() {
            SupportedBufferSize::Range { max, .. } => *max,
            // TODO: Different buffer sizes for different contexts?
            SupportedBufferSize::Unknown => 1024,
        });

        let raw_channels = config.channels();
        let channels = if Self::channel_layout_raw(raw_channels).is_some() {
            raw_channels
        } else {
            raw_channels.clamp(1, Self::MAX_AUDIO_CHANNELS)
        };

        Self {
            sample_format,
            sample_rate: config.sample_rate().0,
            // we do this here and only here bc we know it's cpal-related
            channels: channels.into(),
            time_base: FFRational(1, 1_000_000),
            buffer_size,
        }
    }

    pub fn from_decoder(decoder: &ffmpeg::codec::decoder::Audio) -> Result<Self, AudioInfoError> {
        Self::channel_layout_raw(decoder.channels())
            .ok_or(AudioInfoError::ChannelLayout(decoder.channels()))?;

        Ok(Self {
            sample_format: decoder.format(),
            sample_rate: decoder.rate(),
            // TODO: Use channel layout when we support more than just mono/stereo
            channels: usize::from(decoder.channels()),
            time_base: decoder.time_base(),
            buffer_size: decoder.frame_size(),
        })
    }

    const fn channel_layout_raw(channels: u16) -> Option<ChannelLayout> {
        Some(match channels {
            1 => ChannelLayout::MONO,
            2 => ChannelLayout::STEREO,
            3 => ChannelLayout::SURROUND,
            4 => ChannelLayout::QUAD,
            5 => ChannelLayout::_5POINT0,
            6 => ChannelLayout::_5POINT1,
            7 => ChannelLayout::_6POINT1,
            8 => ChannelLayout::_7POINT1,
            _ => return None,
        })
    }

    pub fn channel_layout(&self) -> ChannelLayout {
        // Clamp channels to supported range and return appropriate layout.
        // This prevents panics when audio devices report unusual channel counts
        // (e.g., 0 channels or more than 8 channels).
        let clamped_channels = (self.channels as u16).clamp(1, 8);
        Self::channel_layout_raw(clamped_channels)
            .unwrap_or(ChannelLayout::STEREO)
    }

    pub fn sample_size(&self) -> usize {
        self.sample_format.bytes()
    }

    pub const fn rate(&self) -> i32 {
        self.sample_rate as i32
    }

    pub fn empty_frame(&self, sample_count: usize) -> frame::Audio {
        let mut frame = frame::Audio::new(self.sample_format, sample_count, self.channel_layout());
        frame.set_rate(self.sample_rate);

        frame
    }

    /// Always expects packed input data
    pub fn wrap_frame_with_max_channels(
        &self,
        packed_data: &[u8],
        max_channels: usize,
    ) -> frame::Audio {
        // Handle 0 channels by treating as mono to avoid division by zero
        // and unreachable code paths. This can happen with misconfigured audio devices.
        let effective_channels = self.channels.max(1);
        let out_channels = effective_channels.min(max_channels.max(1));

        let sample_size = self.sample_size();
        let packed_sample_size = sample_size * effective_channels;
        let samples = packed_data.len() / packed_sample_size;

        let mut frame = frame::Audio::new(
            self.sample_format,
            samples,
            ChannelLayout::default(out_channels as i32),
        );
        frame.set_rate(self.sample_rate);

        if effective_channels == 1 || (frame.is_packed() && effective_channels <= out_channels) {
            // frame is allocated with parameters derived from packed_data, so this is safe
            frame.data_mut(0)[0..packed_data.len()].copy_from_slice(packed_data);
        } else if frame.is_packed() && effective_channels > out_channels {
            for (chunk_index, packed_chunk) in packed_data.chunks(packed_sample_size).enumerate() {
                let start = chunk_index * sample_size * out_channels;

                let copy_len = sample_size * out_channels;

                if let (Some(chunk_slice), Some(frame_slice)) = (
                    packed_chunk.get(0..copy_len),
                    frame.data_mut(0).get_mut(start..start + copy_len),
                ) {
                    frame_slice.copy_from_slice(chunk_slice);
                }
            }
        } else {
            for (chunk_index, packed_chunk) in packed_data.chunks(packed_sample_size).enumerate() {
                let start = chunk_index * sample_size;

                for channel in 0..out_channels {
                    let channel_start = channel * sample_size;
                    let channel_end = channel_start + sample_size;
                    if let (Some(chunk_slice), Some(frame_slice)) = (
                        packed_chunk.get(channel_start..channel_end),
                        frame.data_mut(channel).get_mut(start..start + sample_size),
                    ) {
                        frame_slice.copy_from_slice(chunk_slice);
                    }
                }
            }
        }

        frame
    }

    /// Always expects packed input data
    pub fn wrap_frame(&self, data: &[u8]) -> frame::Audio {
        self.wrap_frame_with_max_channels(data, self.channels)
    }

    pub fn with_max_channels(&self, channels: u16) -> Self {
        let mut this = *self;
        this.channels = this.channels.min(channels as usize);
        this
    }
}

pub enum RawVideoFormat {
    Bgra,
    Mjpeg,
    Uyvy,
    RawRgb,
    Nv12,
    Nv21,
    Gray,
    Gray16,
    Yuyv422,
    Yuv420p,
    Rgba,
    Rgb565,
    P010,
}

#[derive(Debug, Copy, Clone)]
pub struct VideoInfo {
    pub pixel_format: Pixel,
    pub width: u32,
    pub height: u32,
    pub time_base: FFRational,
    pub frame_rate: FFRational,
}

impl VideoInfo {
    pub fn from_raw(format: RawVideoFormat, width: u32, height: u32, fps: u32) -> Self {
        Self {
            pixel_format: match format {
                RawVideoFormat::Bgra => Pixel::BGRA,
                RawVideoFormat::Mjpeg => Pixel::YUVJ422P,
                RawVideoFormat::Uyvy => Pixel::UYVY422,
                RawVideoFormat::RawRgb => Pixel::RGB24,
                RawVideoFormat::Nv12 => Pixel::NV12,
                RawVideoFormat::Nv21 => Pixel::NV21,
                RawVideoFormat::Gray => Pixel::GRAY8,
                RawVideoFormat::Gray16 => Pixel::GRAY16LE,
                RawVideoFormat::Yuyv422 => Pixel::YUYV422,
                RawVideoFormat::Yuv420p => Pixel::YUV420P,
                RawVideoFormat::Rgba => Pixel::RGBA,
                RawVideoFormat::Rgb565 => Pixel::RGB565LE,
                RawVideoFormat::P010 => Pixel::P010LE,
            },
            width,
            height,
            time_base: FFRational(1, 1_000_000),
            frame_rate: FFRational(fps as i32, 1),
        }
    }

    pub fn from_raw_ffmpeg(pixel_format: Pixel, width: u32, height: u32, fps: u32) -> Self {
        Self {
            pixel_format,
            width,
            height,
            time_base: FFRational(1, 1_000_000),
            frame_rate: FFRational(fps as i32, 1),
        }
    }

    pub fn fps(&self) -> u32 {
        self.frame_rate.0 as u32
    }

    pub fn scaled(&self, width: u32, fps: u32) -> Self {
        let (width, height) = match self.width <= width {
            true => (self.width, self.height),
            false => {
                let new_width = width & !1;
                let new_height = (((new_width as f32) * (self.height as f32) / (self.width as f32))
                    .round() as u32)
                    & !1;
                (new_width, new_height)
            }
        };

        Self {
            pixel_format: self.pixel_format,
            width,
            height,
            time_base: self.time_base,
            frame_rate: FFRational(fps.try_into().unwrap(), 1),
        }
    }

    pub fn wrap_frame(&self, data: &[u8], timestamp: i64, stride: usize) -> frame::Video {
        let mut frame = frame::Video::new(self.pixel_format, self.width, self.height);
        frame.set_pts(Some(timestamp));

        let frame_stride = frame.stride(0);
        let frame_height = self.height as usize;

        // Ensure we don't try to copy more data than we have
        if frame.stride(0) == self.width as usize {
            let copy_len = std::cmp::min(data.len(), frame.data_mut(0).len());
            frame.data_mut(0)[0..copy_len].copy_from_slice(&data[0..copy_len]);
        } else {
            for line in 0..frame_height {
                if line * stride >= data.len() {
                    break; // Stop if we run out of source data
                }

                let src_start = line * stride;
                let src_end = std::cmp::min(src_start + frame_stride, data.len());
                if src_end <= src_start {
                    break; // Stop if we can't get any more source data
                }

                let dst_start = line * frame_stride;
                let dst_end = dst_start + (src_end - src_start);

                // Only copy if we have enough destination space
                if dst_end <= frame.data_mut(0).len() {
                    frame.data_mut(0)[dst_start..dst_end]
                        .copy_from_slice(&data[src_start..src_end]);
                }
            }
        }

        frame
    }
}

pub fn ensure_even(value: u32) -> u32 {
    let adjusted = value - (value % 2);
    if adjusted == 0 { 2 } else { adjusted }
}

pub fn ffmpeg_sample_format_for(sample_format: SampleFormat) -> Option<Sample> {
    match sample_format {
        SampleFormat::U8 => Some(Sample::U8(Type::Planar)),
        SampleFormat::I16 => Some(Sample::I16(Type::Planar)),
        SampleFormat::I32 => Some(Sample::I32(Type::Planar)),
        SampleFormat::I64 => Some(Sample::I64(Type::Planar)),
        SampleFormat::F32 => Some(Sample::F32(Type::Planar)),
        SampleFormat::F64 => Some(Sample::F64(Type::Planar)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod audio_info {
        use super::*;

        #[test]
        fn wrap_packed_frame() {
            let info = AudioInfo::new_raw(Sample::U8(Type::Packed), 2, 4);

            let input = &[1, 2, 3, 4, 1, 2, 3, 4];
            let frame = info.wrap_frame(input);

            assert_eq!(&frame.data(0)[0..input.len()], input);
        }

        #[test]
        fn wrap_planar_frame() {
            let info = AudioInfo::new_raw(Sample::U8(Type::Planar), 2, 4);

            let input = &[1, 2, 3, 4, 1, 2, 3, 4];
            let frame = info.wrap_frame(input);

            assert_eq!(frame.planes(), 4);
            assert_eq!(&frame.data(0)[0..2], &[1, 1]);
            assert_eq!(&frame.data(1)[0..2], &[2, 2]);
            assert_eq!(&frame.data(2)[0..2], &[3, 3]);
            assert_eq!(&frame.data(3)[0..2], &[4, 4]);
        }

        #[test]
        fn wrap_packed_frame_max_channels() {
            let info = AudioInfo::new_raw(Sample::U8(Type::Packed), 2, 4);

            let input = &[1, 2, 3, 4, 1, 2, 3, 4];
            let frame = info.wrap_frame_with_max_channels(input, 2);

            assert_eq!(&frame.data(0)[0..4], &[1, 2, 1, 2]);
        }

        #[test]
        fn wrap_planar_frame_max_channels() {
            let info = AudioInfo::new_raw(Sample::U8(Type::Planar), 2, 4);

            let input = &[1, 2, 3, 4, 1, 2, 3, 4];
            let frame = info.wrap_frame_with_max_channels(input, 2);

            assert_eq!(frame.planes(), 2);
            assert_eq!(&frame.data(0)[0..2], &[1, 1]);
            assert_eq!(&frame.data(1)[0..2], &[2, 2]);
        }

        #[test]
        fn channel_layout_returns_valid_layout_for_supported_counts() {
            // Test all supported channel counts (1-8)
            for channels in 1..=8u16 {
                let info = AudioInfo::new_raw(Sample::F32(Type::Planar), 48000, channels);
                // Should not panic and should return a valid layout
                let layout = info.channel_layout();
                assert!(!layout.is_empty());
            }
        }

        #[test]
        fn channel_layout_handles_zero_channels() {
            // Zero channels should be clamped to 1 (MONO)
            let info = AudioInfo::new_raw(Sample::F32(Type::Planar), 48000, 0);
            let layout = info.channel_layout();
            assert_eq!(layout, ChannelLayout::MONO);
        }

        #[test]
        fn channel_layout_handles_excessive_channels() {
            // More than 8 channels should be clamped to 8 (7.1 surround)
            for channels in [9, 10, 16, 32, 64] {
                let info = AudioInfo::new_raw(Sample::F32(Type::Planar), 48000, channels);
                let layout = info.channel_layout();
                assert_eq!(layout, ChannelLayout::_7POINT1);
            }
        }

        #[test]
        fn wrap_frame_handles_zero_channels() {
            // Zero channels should be treated as mono to avoid division by zero
            let info = AudioInfo::new_raw(Sample::U8(Type::Packed), 2, 0);
            let input = &[1, 2, 3, 4];
            // This should not panic
            let frame = info.wrap_frame(input);
            // With effective_channels = 1, all input should be copied as mono
            assert_eq!(&frame.data(0)[0..input.len()], input);
        }
    }
}
