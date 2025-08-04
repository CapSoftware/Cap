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
    pub const MAX_AUDIO_CHANNELS: u16 = 2;

    pub fn new(
        sample_format: Sample,
        sample_rate: u32,
        channel_count: u16,
    ) -> Result<Self, AudioInfoError> {
        Self::channel_layout_raw(channel_count)
            .ok_or(AudioInfoError::ChannelLayout(channel_count))?;

        Ok(Self {
            sample_format,
            sample_rate,
            channels: channel_count.into(),
            time_base: FFRational(1, 1_000_000),
            buffer_size: 1024,
        })
    }

    pub fn from_stream_config(config: &SupportedStreamConfig) -> Self {
        let sample_format = ffmpeg_sample_format_for(config.sample_format()).unwrap();
        let buffer_size = match config.buffer_size() {
            SupportedBufferSize::Range { max, .. } => *max,
            // TODO: Different buffer sizes for different contexts?
            SupportedBufferSize::Unknown => 1024,
        };

        let channels = config.channels().clamp(1, Self::MAX_AUDIO_CHANNELS);

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

    fn channel_layout_raw(channels: u16) -> Option<ChannelLayout> {
        Some(match channels {
            1 => ChannelLayout::MONO,
            2 => ChannelLayout::STEREO,
            _ => return None,
        })
    }

    pub fn channel_layout(&self) -> ChannelLayout {
        Self::channel_layout_raw(self.channels as u16).unwrap()
    }

    pub fn sample_size(&self) -> usize {
        self.sample_format.bytes()
    }

    pub fn rate(&self) -> i32 {
        self.sample_rate.try_into().unwrap()
    }

    pub fn empty_frame(&self, sample_count: usize) -> frame::Audio {
        let mut frame = frame::Audio::new(self.sample_format, sample_count, self.channel_layout());
        frame.set_rate(self.sample_rate);

        frame
    }

    pub fn wrap_frame(&self, data: &[u8], timestamp: i64) -> frame::Audio {
        let sample_size = self.sample_size();
        let interleaved_chunk_size = sample_size * self.channels;
        let samples = data.len() / interleaved_chunk_size;

        let mut frame = frame::Audio::new(self.sample_format, samples, self.channel_layout());
        frame.set_pts(Some(timestamp));
        frame.set_rate(self.sample_rate);

        match self.channels {
            0 => unreachable!(),
            1 | _ if frame.is_packed() => frame.data_mut(0)[0..data.len()].copy_from_slice(data),
            // cpal *always* returns interleaved data (i.e. the first sample from every channel, followed
            // by the second sample from every channel, et cetera). Many audio codecs work better/primarily
            // with planar data, so we de-interleave it here if there is more than one channel.
            channel_count => {
                for (chunk_index, interleaved_chunk) in
                    data.chunks(interleaved_chunk_size).enumerate()
                {
                    let start = chunk_index * sample_size;
                    let end = start + sample_size;

                    for channel in 0..channel_count {
                        let channel_start = channel * sample_size;
                        let channel_end = channel_start + sample_size;
                        frame.plane_data_mut(channel)[start..end]
                            .copy_from_slice(&interleaved_chunk[channel_start..channel_end]);
                    }
                }
            }
        }

        frame
    }
}

pub enum RawVideoFormat {
    Bgra,
    Mjpeg,
    Uyvy,
    RawRgb,
    Nv12,
    Gray,
    YUYV420,
    Rgba,
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
                RawVideoFormat::Gray => Pixel::GRAY8,
                RawVideoFormat::YUYV420 => Pixel::YUV420P,
                RawVideoFormat::Rgba => Pixel::RGBA,
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

        let frame_stride = frame.stride(0) as usize;
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

pub trait PlanarData {
    fn plane_data(&self, index: usize) -> &[u8];

    fn plane_data_mut(&mut self, index: usize) -> &mut [u8];
}

// The ffmpeg crate's implementation of the `data_mut` function is wrong for audio;
// per [the FFmpeg docs](https://www.ffmpeg.org/doxygen/7.0/structAVFrame.html]) only
// the linesize of the first plane may be set for planar audio, and so we need to use
// that linesize for the rest of the planes (else they will appear to be empty slices).
impl PlanarData for frame::Audio {
    #[inline]
    fn plane_data(&self, index: usize) -> &[u8] {
        if index >= self.planes() {
            panic!("out of bounds");
        }

        unsafe {
            std::slice::from_raw_parts(
                (*self.as_ptr()).data[index],
                (*self.as_ptr()).linesize[0] as usize,
            )
        }
    }

    #[inline]
    fn plane_data_mut(&mut self, index: usize) -> &mut [u8] {
        if index >= self.planes() {
            panic!("out of bounds");
        }

        unsafe {
            std::slice::from_raw_parts_mut(
                (*self.as_mut_ptr()).data[index],
                (*self.as_ptr()).linesize[0] as usize,
            )
        }
    }
}
