use cap_media_info::AudioInfo;
use ffmpeg::{format, frame};
use std::{path::PathBuf, time::Duration};

use crate::audio::aac::{AACEncoder, AACEncoderError};

pub struct FragmentedAudioFile {
    encoder: AACEncoder,
    output: format::context::Output,
    finished: bool,
    has_frames: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum InitError {
    #[error("FFmpeg: {0}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("Encoder: {0}")]
    Encoder(#[from] AACEncoderError),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(thiserror::Error, Debug)]
pub enum FinishError {
    #[error("Already finished")]
    AlreadyFinished,
    #[error("{0}")]
    WriteTrailerFailed(ffmpeg::Error),
}

fn option_result(value: i32) -> Result<(), ffmpeg::Error> {
    if value < 0 {
        Err(ffmpeg::Error::from(value))
    } else {
        Ok(())
    }
}

fn configure_fragmentation(output: &mut format::context::Output) -> Result<(), ffmpeg::Error> {
    // Audio-only streams cannot trigger frag_keyframe. Fragment cuts and AVIO
    // flushes are separate requirements for exposing bytes before finalization.
    unsafe {
        let context = output.as_mut_ptr();
        option_result(ffmpeg::ffi::av_opt_set(
            (*context).priv_data,
            c"movflags".as_ptr(),
            c"frag_keyframe+empty_moov+default_base_moof+skip_trailer".as_ptr(),
            0,
        ))?;
        option_result(ffmpeg::ffi::av_opt_set_int(
            (*context).priv_data,
            c"frag_duration".as_ptr(),
            2_000_000,
            0,
        ))?;
        option_result(ffmpeg::ffi::av_opt_set_int(
            context.cast(),
            c"flush_packets".as_ptr(),
            1,
            0,
        ))
    }
}

impl FragmentedAudioFile {
    pub fn init(mut output_path: PathBuf, audio_config: AudioInfo) -> Result<Self, InitError> {
        output_path.set_extension("m4a");

        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut output = format::output_as(&output_path, "mp4")?;

        configure_fragmentation(&mut output)?;

        let encoder = AACEncoder::init(audio_config, &mut output)?;

        output.write_header()?;

        Ok(Self {
            encoder,
            output,
            finished: false,
            has_frames: false,
        })
    }

    pub fn encoder(&self) -> &AACEncoder {
        &self.encoder
    }

    pub fn queue_frame(
        &mut self,
        frame: frame::Audio,
        timestamp: Duration,
    ) -> Result<(), ffmpeg::Error> {
        self.has_frames = true;
        self.encoder.send_frame(frame, timestamp, &mut self.output)
    }

    pub fn finish(&mut self) -> Result<Result<(), ffmpeg::Error>, FinishError> {
        self.finish_with_timestamp(Duration::ZERO)
    }

    pub fn finish_with_timestamp(
        &mut self,
        _: Duration,
    ) -> Result<Result<(), ffmpeg::Error>, FinishError> {
        if self.finished {
            return Err(FinishError::AlreadyFinished);
        }

        self.finished = true;

        let flush_result = if self.has_frames {
            self.encoder.flush(&mut self.output)
        } else {
            Ok(())
        };
        let trailer_result = self.output.write_trailer();
        finish_result(flush_result, trailer_result)
    }
}

fn finish_result(
    flush_result: Result<(), ffmpeg::Error>,
    trailer_result: Result<(), ffmpeg::Error>,
) -> Result<Result<(), ffmpeg::Error>, FinishError> {
    trailer_result.map_err(FinishError::WriteTrailerFailed)?;
    Ok(flush_result)
}

impl Drop for FragmentedAudioFile {
    fn drop(&mut self) {
        let _ = self.finish_with_timestamp(Duration::ZERO);
    }
}

#[cfg(test)]
mod publication_tests {
    use super::*;
    use ffmpeg::{ChannelLayout, format::Sample, format::sample::Type};
    use std::ffi::CStr;

    fn value(output: &mut format::context::Output, name: &CStr, private: bool) -> i64 {
        unsafe {
            let context = output.as_mut_ptr();
            let target = if private {
                (*context).priv_data
            } else {
                context.cast()
            };
            let mut result = 0;
            assert_eq!(
                ffmpeg::ffi::av_opt_get_int(target, name.as_ptr(), 0, &mut result),
                0
            );
            result
        }
    }

    fn queue_tone(output: &mut FragmentedAudioFile, blocks: i64) {
        for block in 0..blocks {
            let mut frame =
                ffmpeg::frame::Audio::new(Sample::F32(Type::Packed), 1024, ChannelLayout::MONO);
            frame.set_rate(48_000);
            for (index, value) in frame.data_mut(0)[..1024 * 4]
                .chunks_exact_mut(4)
                .enumerate()
            {
                let position = (block * 1024) as f32 + index as f32;
                let sample = 0.125 * (position * 880.0 * std::f32::consts::TAU / 48_000.0).sin();
                value.copy_from_slice(&sample.to_ne_bytes());
            }
            output
                .queue_frame(
                    frame,
                    Duration::from_secs_f64(block as f64 * 1024.0 / 48_000.0),
                )
                .unwrap();
        }
    }

    #[test]
    fn fragmented_audio_sets_both_publication_options() {
        let directory = tempfile::tempdir().unwrap();
        let mut output = format::output_as(&directory.path().join("options.m4a"), "mp4").unwrap();
        configure_fragmentation(&mut output).unwrap();
        assert_eq!(value(&mut output, c"frag_duration", true), 2_000_000);
        assert_eq!(value(&mut output, c"flush_packets", false), 1);
        assert_ne!(value(&mut output, c"movflags", true), 0);
    }

    #[test]
    fn fragmented_audio_rejects_unsupported_mux_options() {
        let directory = tempfile::tempdir().unwrap();
        let mut output = format::output_as(&directory.path().join("wrong.ogg"), "ogg").unwrap();
        assert!(configure_fragmentation(&mut output).is_err());
    }

    #[test]
    fn fragmented_audio_option_errors_are_not_ignored() {
        assert!(option_result(0).is_ok());
        assert!(option_result(-22).is_err());
        assert!(option_result(ffmpeg::ffi::AVERROR_OPTION_NOT_FOUND).is_err());
    }

    #[test]
    fn fragmented_audio_exposes_packets_before_finish() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("before-finish.m4a");
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 1);
        let mut output = FragmentedAudioFile::init(path.clone(), info).unwrap();
        queue_tone(&mut output, 120);
        let mut input = format::input(&path).unwrap();
        assert!(input.packets().next().is_some());
        drop(input);
        output.finish().unwrap().unwrap();
    }

    #[test]
    fn short_fragmented_audio_remains_readable_after_finish() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("short.m4a");
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 1);
        let mut output = FragmentedAudioFile::init(path.clone(), info).unwrap();
        queue_tone(&mut output, 10);
        output.finish().unwrap().unwrap();
        let mut input = format::input(&path).unwrap();
        assert!(input.packets().next().is_some());
    }

    #[test]
    fn fragmented_audio_terminal_success_requires_both_stages() {
        assert!(matches!(finish_result(Ok(()), Ok(())), Ok(Ok(()))));
    }

    #[test]
    fn fragmented_audio_preserves_encoder_flush_failure() {
        assert!(matches!(
            finish_result(Err(ffmpeg::Error::InvalidData), Ok(())),
            Ok(Err(ffmpeg::Error::InvalidData))
        ));
    }

    #[test]
    fn fragmented_audio_reports_trailer_failure() {
        assert!(matches!(
            finish_result(Ok(()), Err(ffmpeg::Error::InvalidData)),
            Err(FinishError::WriteTrailerFailed(ffmpeg::Error::InvalidData))
        ));
    }

    #[test]
    fn fragmented_audio_reports_trailer_failure_after_failed_flush() {
        assert!(matches!(
            finish_result(Err(ffmpeg::Error::InvalidData), Err(ffmpeg::Error::Bug)),
            Err(FinishError::WriteTrailerFailed(ffmpeg::Error::Bug))
        ));
    }

    #[test]
    fn fragmented_audio_does_not_assume_reported_eof_is_benign() {
        assert!(matches!(
            finish_result(Err(ffmpeg::Error::Eof), Ok(())),
            Ok(Err(ffmpeg::Error::Eof))
        ));
        assert!(matches!(
            finish_result(Ok(()), Err(ffmpeg::Error::Eof)),
            Err(FinishError::WriteTrailerFailed(ffmpeg::Error::Eof))
        ));
    }

    #[test]
    fn fragmented_audio_empty_track_without_io_error_can_finish() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("empty-finish.m4a");
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 1);
        let mut output = FragmentedAudioFile::init(path, info).unwrap();
        output.finish().unwrap().unwrap();
    }

    fn set_output_error(output: &mut FragmentedAudioFile) {
        unsafe {
            let context = output.output.as_mut_ptr();
            assert!(!(*context).pb.is_null());
            (*(*context).pb).error = ffmpeg::Error::Other {
                errno: ffmpeg::error::EIO,
            }
            .into();
        }
    }

    #[test]
    fn fragmented_audio_sticky_io_error_cannot_report_terminal_success() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("failed-finish.m4a");
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 1);
        let mut output = FragmentedAudioFile::init(path.clone(), info).unwrap();
        queue_tone(&mut output, 120);
        let prefix = std::fs::read(&path).unwrap();
        assert!(!prefix.is_empty());
        set_output_error(&mut output);
        assert!(!matches!(output.finish(), Ok(Ok(()))));
        assert!(matches!(output.finish(), Err(FinishError::AlreadyFinished)));
        drop(output);
        assert!(std::fs::read(&path).unwrap().starts_with(&prefix));
    }

    #[test]
    fn fragmented_audio_empty_track_trailer_error_is_reported() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("empty-failed-finish.m4a");
        let info = AudioInfo::new_raw(Sample::F32(Type::Packed), 48_000, 1);
        let mut output = FragmentedAudioFile::init(path.clone(), info).unwrap();
        set_output_error(&mut output);
        assert!(matches!(
            output.finish(),
            Err(FinishError::WriteTrailerFailed(_))
        ));
        drop(output);
        assert!(path.exists());
    }
}
