use cpal::{SampleFormat, StreamConfig};
use ffmpeg::format::{Sample, sample};

pub trait DataExt {
    fn as_ffmpeg(&self, config: &StreamConfig) -> ffmpeg::frame::Audio;
}

impl DataExt for ::cpal::Data {
    fn as_ffmpeg(&self, config: &StreamConfig) -> ffmpeg::frame::Audio {
        let format_typ = sample::Type::Packed;

        let sample_size = self.sample_format().sample_size();
        let sample_count = self.bytes().len() / (sample_size * config.channels as usize);

        let mut ffmpeg_frame = ffmpeg::frame::Audio::new(
            match self.sample_format() {
                SampleFormat::F32 => Sample::F32(format_typ),
                SampleFormat::F64 => Sample::F64(format_typ),
                SampleFormat::I16 => Sample::I16(format_typ),
                SampleFormat::I32 => Sample::I32(format_typ),
                SampleFormat::U8 => Sample::U8(format_typ),
                _ => panic!("Unsupported sample format"),
            },
            sample_count,
            ffmpeg::ChannelLayout::default(config.channels as i32),
        );

        if matches!(format_typ, sample::Type::Planar) {
            for i in 0..config.channels {
                let plane_size = sample_count * sample_size;
                let base = (i as usize) * plane_size;

                ffmpeg_frame
                    .data_mut(i as usize)
                    .copy_from_slice(&self.bytes()[base..base + plane_size]);
            }
        } else {
            ffmpeg_frame.data_mut(0).copy_from_slice(self.bytes());
        }

        ffmpeg_frame.set_rate(config.sample_rate.0);

        ffmpeg_frame
    }
}
