use cpal::{Sample as CpalSample, SampleFormat, SupportedBufferSize, SupportedStreamConfig};
pub use ffmpeg::format::{
    pixel::Pixel,
    sample::{Sample, Type},
};
use ffmpeg::sys::AVPixelFormat;
pub use ffmpeg::util::{
    channel_layout::ChannelLayout,
    frame::{Audio as FFAudio, Frame as FFFrame, Video as FFVideo},
    rational::Rational as FFRational,
};
pub use ffmpeg::{Error as FFError, Packet as FFPacket};

pub enum RawVideoFormat {
    Bgra,
    Mjpeg,
    Yuyv,
    RawRgb,
    Nv12,
    Gray,
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
impl PlanarData for FFAudio {
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

#[derive(Debug, Copy, Clone)]
pub struct AudioInfo {
    pub sample_format: Sample,
    pub sample_rate: u32,
    pub channels: usize,
    pub time_base: FFRational,
    pub buffer_size: u32,
}

impl AudioInfo {
    pub fn new(sample_format: Sample, sample_rate: u32, channel_count: u16) -> Self {
        Self {
            sample_format,
            sample_rate,
            channels: channel_count.into(),
            time_base: FFRational(1, 1_000_000),
            buffer_size: 1024,
        }
    }

    pub fn from_stream_config(config: &SupportedStreamConfig) -> Self {
        let sample_format = ffmpeg_sample_format_for(config.sample_format()).unwrap();
        let buffer_size = match config.buffer_size() {
            SupportedBufferSize::Range { max, .. } => *max,
            // TODO: Different buffer sizes for different contexts?
            SupportedBufferSize::Unknown => 1024,
        };

        Self {
            sample_format,
            sample_rate: config.sample_rate().0,
            channels: config.channels().into(),
            time_base: FFRational(1, 1_000_000),
            buffer_size,
        }
    }

    pub fn sample_size(&self) -> usize {
        self.sample_format.bytes()
    }

    pub fn rate(&self) -> i32 {
        self.sample_rate.try_into().unwrap()
    }

    pub fn channel_layout(&self) -> ChannelLayout {
        // TODO: Something other than panic. Pretty much all mics I know are either mono or stereo though.
        // Also need to test the audio data capture with a stereo mic at some point.
        match self.channels {
            1 => ChannelLayout::MONO,
            2 => ChannelLayout::STEREO,
            _ => panic!("Unsupported number of audio channels"),
        }
    }

    pub fn empty_frame(&self, sample_count: usize) -> FFAudio {
        let mut frame = FFAudio::new(self.sample_format, sample_count, self.channel_layout());
        frame.set_rate(self.sample_rate);

        frame
    }

    pub fn wrap_frame(&self, data: &[u8], timestamp: i64) -> FFAudio {
        let sample_size = self.sample_size();
        let interleaved_chunk_size = sample_size * self.channels;
        let samples = data.len() / interleaved_chunk_size;

        let mut frame = FFAudio::new(self.sample_format, samples, self.channel_layout());
        frame.set_pts(Some(timestamp));
        frame.set_rate(self.sample_rate);

        match self.channels {
            0 => unreachable!(),
            1 => frame.plane_data_mut(0)[0..data.len()].copy_from_slice(data),
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
                RawVideoFormat::Yuyv => Pixel::UYVY422,
                RawVideoFormat::RawRgb => Pixel::RGB24,
                RawVideoFormat::Nv12 => Pixel::NV12,
                RawVideoFormat::Gray => Pixel::GRAY8,
            },
            width,
            height,
            time_base: FFRational(1, 1_000_000),
            frame_rate: FFRational(fps.try_into().unwrap(), 1),
        }
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
            pixel_format: Pixel::YUV420P,
            width,
            height,
            time_base: self.time_base,
            frame_rate: FFRational(fps.try_into().unwrap(), 1),
        }
    }

    pub fn pixel_format_int(&self) -> i32 {
        // This is necessary because the AVPixelFormat C enum has specific integer values that
        // the Rust PixelFormat enum doesn't replicate. But there is a From/Into conversion
        // between them that we can use to get the right format code.
        let av_pix_fmt: AVPixelFormat = self.pixel_format.into();
        av_pix_fmt as i32
    }

    pub fn wrap_frame(&self, data: &[u8], timestamp: i64) -> FFVideo {
        let mut frame = FFVideo::new(self.pixel_format, self.width, self.height);

        frame.set_pts(Some(timestamp));
        frame.data_mut(0)[0..data.len()].copy_from_slice(data);

        frame
    }
}

pub trait FromByteSlice: cpal::SizedSample + std::fmt::Debug + Send + 'static {
    const BYTE_SIZE: usize;

    fn cast_slice(in_bytes: &[u8], out: &mut [Self]) {
        let filled = std::cmp::min(in_bytes.len() / Self::BYTE_SIZE, out.len());

        for (src, dest) in std::iter::zip(in_bytes.chunks(Self::BYTE_SIZE), &mut *out) {
            *dest = Self::from_bytes(src)
        }
        out[filled..].fill(Self::EQUILIBRIUM);
    }

    fn from_bytes(bytes: &[u8]) -> Self;
}

impl FromByteSlice for u8 {
    const BYTE_SIZE: usize = 1;

    fn cast_slice(in_bytes: &[u8], out: &mut [Self]) {
        let filled = std::cmp::min(in_bytes.len() / Self::BYTE_SIZE, out.len());
        out.copy_from_slice(in_bytes);
        out[filled..].fill(Self::EQUILIBRIUM);
    }

    fn from_bytes(bytes: &[u8]) -> Self {
        bytes[0]
    }
}

macro_rules! slice_castable {
    ( $( $num:ty, $size:literal ),* ) => (
        $(
            impl FromByteSlice for $num {
                const BYTE_SIZE: usize = $size;

                fn from_bytes(bytes: &[u8]) -> Self {
                    Self::from_le_bytes(bytes.try_into().expect("Incorrect byte slice length"))
                }
            }
        )*
    )
}

slice_castable!(i16, 2, i32, 4, i64, 8, f32, 4, f64, 8);
