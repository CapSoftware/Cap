use std::time::Duration;

use cap_media_info::{AudioInfo, FFRational};
use ffmpeg::{
    codec::{context, encoder},
    format::{self, Sample, sample::Type},
    frame,
};

use crate::audio::{base::AudioEncoderBase, buffered_resampler::BufferedResampler};

pub const MP3_ENCODER_NAME: &str = "libmp3lame";

/// Constant bitrate MP3 through LAME. 192 kb/s stereo is transparent for
/// speech and most music and stays about a tenth the size of 16-bit WAV.
pub struct Mp3Encoder {
    base: AudioEncoderBase,
}

#[derive(thiserror::Error, Debug)]
pub enum Mp3EncoderError {
    #[error("{0:?}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("This build of FFmpeg has no MP3 encoder")]
    CodecNotFound,
    #[error("Resampler: {0}")]
    Resampler(ffmpeg::Error),
}

impl Mp3Encoder {
    pub const DEFAULT_BITRATE: usize = 192 * 1000;
    const SAMPLE_FORMAT: Sample = Sample::F32(Type::Planar);

    pub fn is_available() -> bool {
        encoder::find_by_name(MP3_ENCODER_NAME).is_some()
    }

    pub fn init(
        input_config: AudioInfo,
        bitrate: usize,
        output: &mut format::context::Output,
    ) -> Result<Self, Mp3EncoderError> {
        let codec =
            encoder::find_by_name(MP3_ENCODER_NAME).ok_or(Mp3EncoderError::CodecNotFound)?;
        let mut encoder = context::Context::new_with_codec(codec).encoder().audio()?;

        let mut output_config = input_config;
        output_config.sample_format = Self::SAMPLE_FORMAT;
        output_config.channels = output_config.channels.clamp(1, 2);

        let resampler = BufferedResampler::new(input_config, output_config)
            .map_err(Mp3EncoderError::Resampler)?;

        encoder.set_bit_rate(bitrate);
        encoder.set_rate(output_config.rate());
        encoder.set_format(output_config.sample_format);
        encoder.set_channel_layout(output_config.channel_layout());
        encoder.set_time_base(FFRational(1, output_config.rate()));

        let encoder = encoder.open()?;

        let mut output_stream = output.add_stream(codec)?;
        let stream_index = output_stream.index();
        output_stream.set_time_base(FFRational(1, output_config.rate()));
        output_stream.set_parameters(&encoder);

        Ok(Self {
            base: AudioEncoderBase::new(encoder, resampler, stream_index),
        })
    }

    pub fn queue_frame(
        &mut self,
        frame: frame::Audio,
        timestamp: Duration,
        output: &mut format::context::Output,
    ) -> Result<(), ffmpeg::Error> {
        self.base.send_frame(frame, timestamp, output)
    }

    pub fn flush(&mut self, output: &mut format::context::Output) -> Result<(), ffmpeg::Error> {
        self.base.flush(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mp3_encoder_is_in_the_bundled_ffmpeg() {
        ffmpeg::init().unwrap();
        assert!(
            Mp3Encoder::is_available(),
            "{MP3_ENCODER_NAME} is missing from this FFmpeg build"
        );
    }

    #[test]
    fn wav_pcm_encoder_is_in_the_bundled_ffmpeg() {
        ffmpeg::init().unwrap();
        assert!(encoder::find_by_name("pcm_s16le").is_some());
    }

    #[test]
    fn encodes_a_second_of_tone_to_a_valid_mp3() {
        ffmpeg::init().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tone.mp3");
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 2);
        let mut output = format::output(&path).unwrap();
        let mut encoder = Mp3Encoder::init(info, Mp3Encoder::DEFAULT_BITRATE, &mut output).unwrap();
        output.write_header().unwrap();

        let chunk = 4800usize;
        for index in 0..10usize {
            let mut frame = info.empty_frame(chunk);
            let data: &mut [f32] = bytemuck_cast(frame.data_mut(0));
            for (sample, value) in data.chunks_mut(2).enumerate() {
                let t = (index * chunk + sample) as f32 / 48_000.0;
                let v = (t * 440.0 * std::f32::consts::TAU).sin() * 0.5;
                value[0] = v;
                value[1] = v;
            }
            encoder
                .queue_frame(
                    frame,
                    Duration::from_secs_f64((index * chunk) as f64 / 48_000.0),
                    &mut output,
                )
                .unwrap();
        }
        encoder.flush(&mut output).unwrap();
        output.write_trailer().unwrap();

        let input = format::input(&path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Audio).unwrap();
        let decoder = context::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .audio()
            .unwrap();
        assert_eq!(decoder.id(), ffmpeg::codec::Id::MP3);
        assert_eq!(decoder.rate(), 48_000);
        assert_eq!(decoder.channels(), 2);
        let duration = input.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE);
        assert!((duration - 1.0).abs() < 0.1, "duration {duration}");
        let size = std::fs::metadata(&path).unwrap().len();
        assert!((20_000..30_000).contains(&size), "size {size}");
    }

    fn bytemuck_cast(bytes: &mut [u8]) -> &mut [f32] {
        let (prefix, floats, _) = unsafe { bytes.align_to_mut::<f32>() };
        assert!(prefix.is_empty());
        floats
    }
}
