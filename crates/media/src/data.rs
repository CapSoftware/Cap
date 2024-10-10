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

pub enum RawAudioFormat {
    U8,
    I16,
    I32,
    I64,
    F32,
    F64,
}

pub enum RawVideoFormat {
    Bgra,
    Yuyv,
    RawRgb,
    Nv12,
}

impl From<RawAudioFormat> for Sample {
    fn from(value: RawAudioFormat) -> Self {
        match value {
            RawAudioFormat::U8 => Self::U8(Type::Packed),
            RawAudioFormat::I16 => Self::I16(Type::Packed),
            RawAudioFormat::I32 => Self::I32(Type::Packed),
            RawAudioFormat::I64 => Self::I64(Type::Packed),
            RawAudioFormat::F32 => Self::F32(Type::Packed),
            RawAudioFormat::F64 => Self::F64(Type::Packed),
        }
    }
}

#[derive(Debug, Copy, Clone)]
pub struct AudioInfo {
    pub sample_format: Sample,
    sample_rate: u32,
    channels: usize,
    pub time_base: FFRational,
    pub buffer_size: u32,
}

impl AudioInfo {
    pub fn from_raw(
        format: RawAudioFormat,
        sample_rate: u32,
        channels: u16,
        buffer_size: u32,
    ) -> Self {
        Self {
            sample_format: format.into(),
            sample_rate,
            channels: channels.into(),
            time_base: FFRational(1, 1_000_000),
            buffer_size,
        }
    }

    pub fn sample_size(&self) -> usize {
        self.sample_format.bytes() * self.channels
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

    pub fn wrap_frame(&self, data: &[u8], timestamp: i64) -> FFAudio {
        let samples = data.len() / self.sample_size();

        let mut frame = FFAudio::new(self.sample_format, samples, self.channel_layout());

        frame.set_pts(Some(timestamp));
        frame.set_rate(self.sample_rate);
        frame.data_mut(0)[0..data.len()].copy_from_slice(data);

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
                RawVideoFormat::Yuyv => Pixel::UYVY422,
                RawVideoFormat::RawRgb => Pixel::RGB24,
                RawVideoFormat::Nv12 => Pixel::NV12,
            },
            width,
            height,
            time_base: FFRational(1, 1_000_000),
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
