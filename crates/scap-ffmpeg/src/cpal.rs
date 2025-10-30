use cpal::{SampleFormat, StreamConfig};
use ffmpeg::format::{Sample, sample};

pub trait DataExt {
    fn as_ffmpeg(&self, config: &StreamConfig) -> ffmpeg::frame::Audio;
}

impl DataExt for ::cpal::Data {
    fn as_ffmpeg(&self, config: &StreamConfig) -> ffmpeg::frame::Audio {
        let format_typ = sample::Type::Packed;

        let sample_size = self.sample_format().sample_size();
        let bytes = self.bytes();
        let sample_count = bytes.len() / (sample_size * config.channels as usize);

        let mut ffmpeg_frame = ffmpeg::frame::Audio::new(
            match self.sample_format() {
                SampleFormat::U8 => Sample::U8(format_typ),
                SampleFormat::I16 => Sample::I16(format_typ),
                SampleFormat::I32 => Sample::I32(format_typ),
                SampleFormat::F32 => Sample::F32(format_typ),
                SampleFormat::F64 => Sample::F64(format_typ),
                _ => panic!("Unsupported sample format"),
            },
            sample_count,
            ffmpeg::ChannelLayout::default(config.channels as i32),
        );

        if matches!(format_typ, sample::Type::Planar) {
            for i in 0..config.channels {
                let plane_size = sample_count * sample_size;
                let base = (i as usize) * plane_size;
                let end = (base + plane_size).min(bytes.len());
                if end <= base {
                    continue;
                }
                let src = &bytes[base..end];
                let dst = ffmpeg_frame.data_mut(i as usize);
                debug_assert!(
                    dst.len() >= src.len(),
                    "FFmpeg plane smaller than CPAL buffer"
                );
                let copy_len = dst.len().min(src.len());
                dst[..copy_len].copy_from_slice(&src[..copy_len]);
            }
        } else {
            let dst = ffmpeg_frame.data_mut(0);
            debug_assert!(
                dst.len() >= bytes.len(),
                "FFmpeg buffer smaller than CPAL buffer"
            );
            let copy_len = dst.len().min(bytes.len());
            dst[..copy_len].copy_from_slice(&bytes[..copy_len]);
        }

        ffmpeg_frame.set_rate(config.sample_rate.0);

        ffmpeg_frame
    }
}
